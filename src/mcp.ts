import {spawn} from 'node:child_process';

/** The native MCP catalog presented by one CodeIndex artifact. */
export type CatalogType = Readonly<{
	serverName: string;
	serverVersion: string;
	tools: readonly string[];
}>;

const CATALOG_TIMEOUT_MS = 20_000;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const toolNamesOf = (value: unknown): readonly string[] => {
	if (!Array.isArray(value)) {
		throw new Error('MCP tools/list result must contain a tools array');
	}

	const names = value.map((item) => {
		if (!isRecord(item) || typeof item['name'] !== 'string' || !TOOL_NAME.test(item['name'])) {
			throw new Error('MCP tools/list returned an invalid tool name');
		}

		return item['name'];
	});

	if (new Set(names).size !== names.length) {
		throw new Error('MCP tools/list returned duplicate tool names');
	}

	return [...names].sort();
};

/**
 * Reads the exact tool-name catalog from a CodeIndex MCP artifact.
 *
 * The catalog is queried with the same native MCP handshake the agent uses.
 * Diagnostics never reach the harness event stream.
 *
 * @param entryPoint - Absolute path to the artifact's MCP entry.
 * @param cwd - Working directory the artifact resolves as its project.
 * @returns Server identity and sorted native tool names.
 */
export const catalogOf = async (entryPoint: string, cwd: string): Promise<CatalogType> =>
	new Promise<CatalogType>((resolve, reject) => {
		const child = spawn(process.execPath, [entryPoint], {cwd, stdio: ['pipe', 'pipe', 'pipe']});
		let buffer = '';
		let settled = false;
		let serverName = 'unknown';
		let serverVersion = 'unknown';

		const finish = (error: Error | null, catalog?: CatalogType): void => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timer);
			child.kill('SIGKILL');

			if (error === null && catalog !== undefined) {
				resolve(catalog);
			} else {
				reject(error ?? new Error('MCP catalog query failed'));
			}
		};

		const timer = setTimeout(() => finish(new Error('MCP catalog query timed out')), CATALOG_TIMEOUT_MS);
		const send = (message: Record<string, unknown>): void => {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		};

		child.on('error', (error) => finish(error));
		child.on('close', (code) => {
			if (!settled) {
				finish(new Error(`MCP artifact exited with ${code ?? 'no status'} before returning its catalog`));
			}
		});

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;

			while (true) {
				const newline = buffer.indexOf('\n');

				if (newline < 0) {
					return;
				}

				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);

				if (line.length === 0) {
					continue;
				}

				let message: Record<string, unknown>;

				try {
					const parsed = JSON.parse(line) as unknown;

					if (!isRecord(parsed)) {
						continue;
					}

					message = parsed;
				} catch {
					continue;
				}

				const id = message['id'];
				const result = isRecord(message['result']) ? message['result'] : null;

				if (id === 1 && result !== null) {
					const info = isRecord(result['serverInfo']) ? result['serverInfo'] : {};
					serverName = typeof info['name'] === 'string' ? info['name'] : 'unknown';
					serverVersion = typeof info['version'] === 'string' ? info['version'] : 'unknown';
					send({jsonrpc: '2.0', method: 'notifications/initialized'});
					send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
					continue;
				}

				if (id === 2 && result !== null) {
					try {
						finish(null, {serverName, serverVersion, tools: toolNamesOf(result['tools'])});
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				}
			}
		});

		send({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: {name: 'codeindex-evaluation', version: '1'},
			},
		});
	});
