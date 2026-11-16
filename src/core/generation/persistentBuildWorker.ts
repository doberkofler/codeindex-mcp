import {setTimeout as delay} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {type ResolvedAdapterDescriptorType} from '../../adapters/loader.ts';
import {type ConfigType} from '../config/config.ts';
import {type DatabaseOpenContextType} from '../storage/database.ts';
import {BuildFailureEnvelopeError, buildFailureFromWorkerPayload, buildFailureOf, type BuildFailureType} from './buildFailure.ts';
import {buildWorkerRunResultFromMessage} from './buildWorkerClient.ts';
import {type BuildWorkerRunResultType} from './buildWorker.ts';
import {cancelExecution, createCancellationBuffer} from './executionCancellation.ts';
import {buildProgressFromWorker, type BuildProgressType} from './buildProgress.ts';

const SHUTDOWN_GRACE_MS = 2000;
const stopWorker = async (worker: Worker): Promise<void> => {
	const {promise: exited, resolve: markExited} = Promise.withResolvers<true>();
	worker.once('exit', () => {
		markExited(true);
	});

	try {
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin.
		worker.postMessage({kind: 'code-index-shutdown'});
	} catch {
		// Fall through to termination.
	}

	await Promise.race([exited, delay(SHUTDOWN_GRACE_MS)]);

	if (worker.threadId !== -1) {
		await worker.terminate();
	}
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

type WaiterType = Readonly<{
	resolve: (result: BuildWorkerRunResultType) => void;
	reject: (error: Error) => void;
	onProgress?: ((progress: BuildProgressType) => void) | undefined;
}>;

export type PersistentBuildWorkerOptionsType = Readonly<{
	workerEntry: string;
	descriptors: readonly ResolvedAdapterDescriptorType[];
	debug: boolean;
	/** Milliseconds an unused worker is retained before it is stopped. Zero keeps it alive. */
	idleMs: number;
	/** Whole process-tree RSS ceiling; a larger sample restarts the worker. */
	maxProcessTreeRssBytes: number;
}>;

export type PersistentBuildWorkerInputType = Readonly<{
	config: ConfigType;
	adapterIds: readonly string[] | null;
	force: boolean;
	ownerId: string;
	startedAtEpoch: number;
	signal?: AbortSignal | undefined;
	onProgress?: ((progress: BuildProgressType) => void) | undefined;
}>;

const unavailableFailure = (): BuildFailureType => buildFailureOf(new Error('Build worker unavailable'), 'worker');

/**
 * Keeps one build worker thread alive across refreshes.
 *
 * The worker retains loaded adapter modules and their compiler sessions. The
 * host owns the lifecycle: idle eviction, a process-tree memory ceiling, crash
 * recovery, and one in-flight build request at a time.
 */
export class PersistentBuildWorker {
	readonly #options: PersistentBuildWorkerOptionsType;
	readonly #waiters = new Map<number, WaiterType>();
	readonly #initializationWaiters = new Map<number, Readonly<{resolve: (value: true) => void; reject: (error: Error) => void}>>();
	readonly #cancellations = new Map<number, SharedArrayBuffer>();
	#worker: Worker | null = null;
	#nextId = 1;
	#idleTimer: ReturnType<typeof setTimeout> | null = null;
	#stopping: Promise<void> | null = null;
	#closed = false;
	#memoryRestarts = 0;
	#crashRestarts = 0;
	#idleRestarts = 0;

	public constructor(options: PersistentBuildWorkerOptionsType) {
		this.#options = options;
	}

	/**
	 * Initializes writable storage inside the retained execution worker.
	 *
	 * @param config - Resolved host configuration.
	 * @param context - Working-copy and project identity.
	 */
	public async initialize(config: ConfigType, context: DatabaseOpenContextType): Promise<void> {
		if (this.#closed) {
			throw new BuildFailureEnvelopeError(unavailableFailure());
		}

		const worker = this.#ensureWorker();
		const id = this.#nextId;
		this.#nextId += 1;
		const {promise, resolve, reject} = Promise.withResolvers<true>();
		this.#initializationWaiters.set(id, {resolve, reject});

		try {
			// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin.
			worker.postMessage({kind: 'code-index-initialize', id, config, context});
			await promise;
		} finally {
			this.#initializationWaiters.delete(id);
		}
	}

	/**
	 * Runs one build request on the retained worker.
	 *
	 * @param input - Attempt configuration, scans, and optional cancellation signal.
	 * @returns The worker's validated build report.
	 * @throws {@link BuildFailureEnvelopeError} When the worker reports or fails.
	 */
	public async run(input: PersistentBuildWorkerInputType): Promise<BuildWorkerRunResultType> {
		if (this.#closed) {
			throw new BuildFailureEnvelopeError(unavailableFailure());
		}

		this.#clearIdle();

		const worker = this.#ensureWorker();
		const id = this.#nextId;
		this.#nextId += 1;
		const {signal} = input;
		const cancellationBuffer = createCancellationBuffer();
		const cancellation: {startedAt: number | null} = {startedAt: null};
		const cancel = (): void => {
			cancellation.startedAt ??= performance.now();
			cancelExecution(cancellationBuffer);
		};

		if (signal !== undefined) {
			if (signal.aborted) {
				cancel();
			} else {
				signal.addEventListener('abort', cancel, {once: true});
			}
		}

		const {promise: resultPromise, resolve, reject} = Promise.withResolvers<BuildWorkerRunResultType>();
		this.#waiters.set(id, {
			resolve,
			reject,
			...(input.onProgress === undefined ? {} : {onProgress: input.onProgress}),
		});
		this.#cancellations.set(id, cancellationBuffer);

		try {
			const request = {
				kind: 'code-index-build',
				id,
				config: input.config,
				adapterIds: input.adapterIds,
				force: input.force,
				ownerId: input.ownerId,
				cancellationBuffer,
				startedAtEpoch: input.startedAtEpoch,
				debug: this.#options.debug,
			};
			// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin.
			worker.postMessage(request);
			const result = await resultPromise;
			const cancellationToSettlementMs = cancellation.startedAt === null ? 0 : Math.round(performance.now() - cancellation.startedAt);
			const peakTreeRss = result.resources['processTreeRssPeakBytes'] ?? 0;

			if (peakTreeRss > this.#options.maxProcessTreeRssBytes) {
				await this.#stop('memory');
			}

			return {
				...result,
				resources: {
					...result.resources,
					cancellationToSettlementMs,
					workerMemoryRestarts: this.#memoryRestarts,
					workerCrashRestarts: this.#crashRestarts,
					workerIdleRestarts: this.#idleRestarts,
				},
			};
		} finally {
			signal?.removeEventListener('abort', cancel);
			this.#waiters.delete(id);
			this.#cancellations.delete(id);

			if (this.#waiters.size === 0) {
				this.#armIdle();
			}
		}
	}

	public async close(): Promise<void> {
		this.#closed = true;
		this.#clearIdle();

		for (const cancellationBuffer of this.#cancellations.values()) {
			cancelExecution(cancellationBuffer);
		}

		for (const waiter of this.#waiters.values()) {
			waiter.reject(new BuildFailureEnvelopeError(buildFailureOf(new Error('Build worker closed'), 'worker')));
		}

		this.#waiters.clear();
		this.#cancellations.clear();
		for (const waiter of this.#initializationWaiters.values()) {
			waiter.reject(new BuildFailureEnvelopeError(buildFailureOf(new Error('Build worker closed'), 'worker')));
		}
		this.#initializationWaiters.clear();
		await this.#stop('shutdown');
	}

	#ensureWorker(): Worker {
		if (this.#worker !== null) {
			return this.#worker;
		}

		const worker = new Worker(this.#options.workerEntry, {
			workerData: {kind: 'code-index-build-host', descriptors: this.#options.descriptors, debug: this.#options.debug},
		});
		this.#worker = worker;

		worker.on('message', (value: unknown) => {
			this.#onMessage(worker, value);
		});
		worker.on('error', (error: unknown) => {
			this.#onFailure(worker, error instanceof Error ? error : new Error(String(error)));
		});
		worker.on('exit', (code: number) => {
			this.#onFailure(worker, new Error(`Index build worker exited with code ${String(code)}`));
		});

		return worker;
	}

	#onMessage(worker: Worker, value: unknown): void {
		if (this.#worker !== worker || !isRecord(value) || typeof value['id'] !== 'number') {
			return;
		}
		const {id} = value;

		if (value['kind'] === 'code-index-initialize-result') {
			this.#onInitializationMessage(id, value);
			return;
		}

		if (value['kind'] === 'code-index-build-progress') {
			this.#onProgressMessage(id, value);
			return;
		}

		if (value['kind'] === 'code-index-build-result') {
			this.#onResultMessage(id, value);
		}
	}

	#onInitializationMessage(id: number, value: Readonly<Record<string, unknown>>): void {
		const waiter = this.#initializationWaiters.get(id);

		if (waiter === undefined) {
			return;
		}

		this.#initializationWaiters.delete(id);

		if (value['ok'] === true) {
			waiter.resolve(true);
			return;
		}

		const failure = buildFailureFromWorkerPayload(value['failure']);
		waiter.reject(new BuildFailureEnvelopeError(failure ?? buildFailureOf(new Error('Worker initialization failed'), 'worker')));
	}

	#onProgressMessage(id: number, value: Readonly<Record<string, unknown>>): void {
		const progress = buildProgressFromWorker(value['progress']);

		if (progress !== null) {
			this.#waiters.get(id)?.onProgress?.(progress);
		}
	}

	#onResultMessage(id: number, value: Readonly<Record<string, unknown>>): void {
		const waiter = this.#waiters.get(id);

		if (waiter === undefined) {
			return;
		}

		this.#waiters.delete(id);

		if (value['ok'] === true) {
			const result = buildWorkerRunResultFromMessage(value);

			if (result === null) {
				waiter.reject(new BuildFailureEnvelopeError(buildFailureOf(new Error('Malformed build report'), 'worker')));
				return;
			}

			waiter.resolve(result);
			return;
		}

		const failure = buildFailureFromWorkerPayload(value['failure']);
		waiter.reject(new BuildFailureEnvelopeError(failure ?? buildFailureOf(new Error('Worker reported no failure envelope'), 'worker')));
	}

	#onFailure(worker: Worker, error: Error): void {
		if (this.#worker !== worker) {
			return;
		}

		this.#worker = null;
		this.#crashRestarts += 1;

		for (const waiter of this.#waiters.values()) {
			waiter.reject(new BuildFailureEnvelopeError(buildFailureOf(error, 'worker')));
		}

		this.#waiters.clear();
		this.#cancellations.clear();
		for (const waiter of this.#initializationWaiters.values()) {
			waiter.reject(new BuildFailureEnvelopeError(buildFailureOf(error, 'worker')));
		}
		this.#initializationWaiters.clear();
	}

	#armIdle(): void {
		this.#clearIdle();

		if (this.#closed || this.#options.idleMs <= 0) {
			return;
		}

		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = null;
			void this.#stop('idle');
		}, this.#options.idleMs);
		this.#idleTimer.unref();
	}

	#clearIdle(): void {
		if (this.#idleTimer !== null) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
		}
	}

	async #stop(reason: 'idle' | 'memory' | 'shutdown'): Promise<void> {
		if (this.#stopping !== null) {
			await this.#stopping;
			return;
		}

		this.#clearIdle();
		const worker = this.#worker;
		this.#worker = null;

		if (worker === null) {
			return;
		}

		if (reason === 'memory') {
			this.#memoryRestarts += 1;
		} else if (reason === 'idle') {
			this.#idleRestarts += 1;
		}

		const stopped = stopWorker(worker);
		this.#stopping = stopped;

		try {
			await stopped;
		} finally {
			if (this.#stopping === stopped) {
				this.#stopping = null;
			}
		}
	}
}
