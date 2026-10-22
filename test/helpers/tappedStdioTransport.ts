import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport, type TransportSendOptions} from '@modelcontextprotocol/client';

const CLOSE_SIGNAL_DELAY_MS = 50;
const CLOSE_KILL_DELAY_MS = 5000;
const EXIT_POLL_MS = 10;

export type TappedStdioOptionsType = Readonly<{
	command: string;
	args: readonly string[];
	env: Readonly<Record<string, string>>;
	cwd: string;
}>;

export type ProcessExitType = Readonly<{code: number | null; signal: NodeJS.Signals | null}>;

/**
 * MCP stdio transport that preserves the child's raw stdout and stderr.
 *
 * The official transport consumes stdout while parsing frames, which hides
 * whether anything other than MCP messages reached the stream. This transport
 * uses the official framing helpers and exposes both raw streams so a system
 * test can assert that stdout carries the transport only.
 */
export class TappedStdioTransport implements Transport {
	public onclose?: () => void;
	public onerror?: (error: Error) => void;
	public onmessage?: (message: JSONRPCMessage) => void;

	readonly #options: TappedStdioOptionsType;
	readonly #readBuffer = new ReadBuffer();
	readonly #stdoutChunks: Buffer[] = [];
	readonly #stderrChunks: Buffer[] = [];
	#child: ChildProcessWithoutNullStreams | null = null;
	#closed = false;

	public constructor(options: TappedStdioOptionsType) {
		this.#options = options;
	}

	/**
	 * Raw bytes the child wrote to stdout.
	 *
	 * @returns Decoded stdout.
	 */
	public get stdout(): string {
		return Buffer.concat(this.#stdoutChunks).toString('utf8');
	}

	/**
	 * Raw bytes the child wrote to stderr.
	 *
	 * @returns Decoded stderr.
	 */
	public get stderr(): string {
		return Buffer.concat(this.#stderrChunks).toString('utf8');
	}

	/**
	 * Settlement of the child process.
	 *
	 * @returns The child's exit code and terminating signal.
	 */
	public get exit(): Promise<ProcessExitType> {
		return this.#waitForExit();
	}

	public async start(): Promise<void> {
		if (this.#child !== null) {
			throw new Error('Transport already started');
		}

		const child = spawn(this.#options.command, [...this.#options.args], {
			cwd: this.#options.cwd,
			env: {...this.#options.env},
			stdio: 'pipe',
		});
		this.#child = child;
		child.once('exit', () => {
			this.onclose?.();
		});
		child.once('error', (error) => {
			this.onerror?.(error);
		});
		child.stdout.on('data', (chunk: Buffer) => {
			this.#acceptStdout(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			this.#stderrChunks.push(chunk);
		});

		// Yield once so a spawn failure reaches the error listener before the
		// client starts sending frames.
		await delay(0);
	}

	public async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
		const child = this.#child;

		if (child === null || this.#closed || child.stdin.destroyed) {
			throw new Error('Transport is not connected');
		}

		child.stdin.write(serializeMessage(message));
		await delay(0);
	}

	public async close(): Promise<void> {
		const child = this.#child;

		if (child === null || this.#closed) {
			return;
		}

		this.#closed = true;
		this.#readBuffer.clear();

		if (child.exitCode !== null || child.signalCode !== null) {
			await this.#waitForExit();
			return;
		}

		child.stdin.end();
		const signalTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGTERM');
			}
		}, CLOSE_SIGNAL_DELAY_MS);
		const killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}, CLOSE_KILL_DELAY_MS);
		signalTimer.unref();
		killTimer.unref();

		try {
			await this.#waitForExit();
		} finally {
			clearTimeout(signalTimer);
			clearTimeout(killTimer);
		}
	}

	/**
	 * Signals the child directly and resolves once it has exited.
	 *
	 * @param signal - Signal to deliver.
	 * @returns The child's exit code and terminating signal.
	 */
	public async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<ProcessExitType> {
		const child = this.#child;

		if (child?.exitCode === null && child.signalCode === null) {
			child.kill(signal);
		}

		const exit = await this.#waitForExit();
		return exit;
	}

	async #waitForExit(): Promise<ProcessExitType> {
		const child = this.#child;

		if (child === null) {
			throw new Error('Transport has not started');
		}

		const exit = await this.#pollExit(child);
		return exit;
	}

	async #pollExit(child: ChildProcessWithoutNullStreams): Promise<ProcessExitType> {
		if (child.exitCode !== null || child.signalCode !== null) {
			return {code: child.exitCode, signal: child.signalCode};
		}

		await delay(EXIT_POLL_MS);
		return this.#pollExit(child);
	}

	#acceptStdout(chunk: Buffer): void {
		this.#stdoutChunks.push(chunk);

		try {
			this.#readBuffer.append(chunk);
			this.#drainMessages();
		} catch (error) {
			this.onerror?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	#drainMessages(): void {
		for (;;) {
			const message = this.#readBuffer.readMessage();

			if (message === null) {
				return;
			}

			this.onmessage?.(message);
		}
	}
}
