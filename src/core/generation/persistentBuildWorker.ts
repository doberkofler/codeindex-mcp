import {setTimeout as delay} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {type ResolvedAdapterDescriptorType} from '../../adapters/loader.ts';
import {type ConfigType} from '../config/config.ts';
import {type BuildReportType} from '../model.ts';
import {processTreeRssBytes} from '../resources/processTree.ts';
import {type AdapterScanPlanType} from './adapterBuild.ts';
import {BuildFailureEnvelopeError, buildFailureFromWorkerPayload, buildFailureOf, type BuildFailureType} from './buildFailure.ts';
import {buildReportFromWorkerMessage} from './buildWorkerClient.ts';

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
	resolve: (report: BuildReportType) => void;
	reject: (error: Error) => void;
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
	scans: readonly AdapterScanPlanType[];
	force: boolean;
	ownerId: string;
	startedAtEpoch: number;
	signal?: AbortSignal | undefined;
}>;

const failureForPlans = (plans: readonly AdapterScanPlanType[]): BuildFailureType => {
	const project = plans.find((plan) => plan.scan !== null)?.scan?.projects.at(0);

	return buildFailureOf(new Error('Build worker unavailable'), 'worker', project === undefined ? null : {name: project.name, file: project.projectFile});
};

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
	#worker: Worker | null = null;
	#nextId = 1;
	#idleTimer: ReturnType<typeof setTimeout> | null = null;
	#stopping: Promise<void> | null = null;
	#closed = false;

	public constructor(options: PersistentBuildWorkerOptionsType) {
		this.#options = options;
	}

	/**
	 * Runs one build request on the retained worker.
	 *
	 * @param input - Attempt configuration, scans, and optional cancellation signal.
	 * @returns The worker's validated build report.
	 * @throws {@link BuildFailureEnvelopeError} When the worker reports or fails.
	 */
	public async run(input: PersistentBuildWorkerInputType): Promise<BuildReportType> {
		if (this.#closed) {
			throw new BuildFailureEnvelopeError(failureForPlans(input.scans));
		}

		this.#clearIdle();

		if (processTreeRssBytes() > this.#options.maxProcessTreeRssBytes) {
			await this.#stop();
		}

		const worker = this.#ensureWorker();
		const id = this.#nextId;
		this.#nextId += 1;
		const {signal} = input;
		const cancel = (): void => {
			try {
				// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin.
				worker.postMessage({kind: 'code-index-cancel', id});
			} catch {
				// The worker may have completed between the abort and this message.
			}
		};

		if (signal !== undefined) {
			if (signal.aborted) {
				cancel();
			} else {
				signal.addEventListener('abort', cancel, {once: true});
			}
		}

		const {promise: reportPromise, resolve, reject} = Promise.withResolvers<BuildReportType>();
		this.#waiters.set(id, {resolve, reject});

		try {
			const request = {
				kind: 'code-index-build',
				id,
				config: input.config,
				scans: input.scans,
				force: input.force,
				ownerId: input.ownerId,
				startedAtEpoch: input.startedAtEpoch,
				debug: this.#options.debug,
			};
			// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no targetOrigin.
			worker.postMessage(request);
			const report = await reportPromise;

			if (processTreeRssBytes() > this.#options.maxProcessTreeRssBytes) {
				await this.#stop();
			}

			return report;
		} finally {
			signal?.removeEventListener('abort', cancel);
			this.#waiters.delete(id);

			if (this.#waiters.size === 0) {
				this.#armIdle();
			}
		}
	}

	public async close(): Promise<void> {
		this.#closed = true;
		this.#clearIdle();

		for (const waiter of this.#waiters.values()) {
			waiter.reject(new BuildFailureEnvelopeError(buildFailureOf(new Error('Build worker closed'), 'worker')));
		}

		this.#waiters.clear();
		await this.#stop();
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
		if (this.#worker !== worker || !isRecord(value) || value['kind'] !== 'code-index-build-result' || typeof value['id'] !== 'number') {
			return;
		}

		const waiter = this.#waiters.get(value['id']);

		if (waiter === undefined) {
			return;
		}

		this.#waiters.delete(value['id']);

		if (value['ok'] === true) {
			const report = buildReportFromWorkerMessage(value);

			if (report === null) {
				waiter.reject(new BuildFailureEnvelopeError(buildFailureOf(new Error('Malformed build report'), 'worker')));
				return;
			}

			waiter.resolve(report);
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

		for (const waiter of this.#waiters.values()) {
			waiter.reject(new BuildFailureEnvelopeError(buildFailureOf(error, 'worker')));
		}

		this.#waiters.clear();
	}

	#armIdle(): void {
		this.#clearIdle();

		if (this.#closed || this.#options.idleMs <= 0) {
			return;
		}

		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = null;
			void this.#stop();
		}, this.#options.idleMs);
		this.#idleTimer.unref();
	}

	#clearIdle(): void {
		if (this.#idleTimer !== null) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
		}
	}

	async #stop(): Promise<void> {
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
