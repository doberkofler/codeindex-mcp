import {once} from 'node:events';
import {createReadStream, existsSync, statSync} from 'node:fs';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {type LoggerType} from '../logging/logger.ts';
import {
	CONSOLE_OPERATIONS,
	type AnalyticsDashboardType,
	type AnalyticsWindowType,
	type ConsoleJobType,
	type ConsoleMetaType,
	type ConsoleOperationType,
	type ConsoleSnapshotType,
} from './contracts.ts';
import {type IndexStatusType} from '../index/model.ts';

export type ConsoleServicePortType = Readonly<{
	readonly meta: ConsoleMetaType;
	readonly status: IndexStatusType;
	readonly jobs: readonly ConsoleJobType[];
	snapshot: () => ConsoleSnapshotType;
	analytics: (window: AnalyticsWindowType) => AnalyticsDashboardType;
	runOperation: (operation: ConsoleOperationType) => ConsoleJobType;
}>;

const {extname, join, resolve, sep} = path;
const MAX_BODY_BYTES = 8192;
const WINDOWS: readonly AnalyticsWindowType[] = ['1h', '24h', '7d', '30d', 'all'];
const JobRequestSchema = z.object({operation: z.enum(CONSOLE_OPERATIONS)});

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	'content-security-policy':
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-resource-policy': 'same-origin',
};

export type ConsoleServerOptionsType = Readonly<{
	service: ConsoleServicePortType;
	token: string;
	staticRoot: string;
	host: string;
	port: number;
	logger: LoggerType;
}>;

export type ConsoleServerHandleType = Readonly<{
	url: string;
	port: number;
	close: () => Promise<void>;
}>;

const tokenMatches = (expected: string, candidate: string): boolean => {
	const expectedBytes = Buffer.from(expected, 'utf8');
	const candidateBytes = Buffer.from(candidate, 'utf8');
	return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
};

const isLoopbackHost = (host: string | undefined): boolean => {
	if (host === undefined) {
		return false;
	}

	const hostname = host.replace(/:\d+$/u, '').replaceAll(/^\[|\]$/gu, '');
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
};

const originAllowed = (origin: string | undefined, port: number): boolean => {
	if (origin === undefined) {
		return true;
	}

	try {
		const parsed = new URL(origin);
		return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.host) && Number(parsed.port || 80) === port;
	} catch {
		return false;
	}
};

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		...SECURITY_HEADERS,
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(Buffer.byteLength(body)),
		'cache-control': 'no-store',
	});
	response.end(body);
};

const sendError = (response: ServerResponse, status: number, message: string): void => {
	sendJson(response, status, {error: {message}});
};

const readBody = async (request: IncomingMessage): Promise<string> => {
	const chunks: Uint8Array[] = [];
	let size = 0;

	for await (const chunk of request) {
		const buffer = chunk instanceof Uint8Array ? new Uint8Array(chunk) : Buffer.from(String(chunk));
		size += buffer.length;

		if (size > MAX_BODY_BYTES) {
			throw new Error('Request body is too large');
		}

		chunks.push(buffer);
	}

	return Buffer.concat(chunks).toString('utf8');
};

const staticPathOf = (pathname: string): string => {
	const decoded = decodeURIComponent(pathname);

	if (decoded.includes('\0')) {
		throw new Error('Invalid path');
	}

	return decoded === '/' ? '/index.html' : decoded;
};

const serveStatic = (response: ServerResponse, staticRoot: string, pathname: string): void => {
	let relativePath: string;

	try {
		relativePath = staticPathOf(pathname);
	} catch {
		sendError(response, 400, 'Invalid path');
		return;
	}

	const candidate = resolve(join(staticRoot, relativePath));
	const root = resolve(staticRoot);

	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
		sendError(response, 403, 'Path is outside the console bundle');
		return;
	}

	if (!existsSync(candidate) || !statSync(candidate).isFile()) {
		sendError(response, 404, 'Not found');
		return;
	}

	const type = CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream';
	const immutable = relativePath.startsWith('/assets/');
	response.writeHead(200, {
		...SECURITY_HEADERS,
		'content-type': type,
		'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
	});
	createReadStream(candidate).pipe(response);
};

const sendSnapshot = (response: ServerResponse, service: ConsoleServicePortType): void => {
	sendJson(response, 200, service.snapshot());
};

type ApiRequestType = Readonly<{request: IncomingMessage; response: ServerResponse; url: URL; service: ConsoleServicePortType; port: number}>;

const handleApi = async (input: ApiRequestType): Promise<boolean> => {
	const {request, response, url, service, port} = input;
	if (!url.pathname.startsWith('/api/')) {
		return false;
	}

	if (request.method === 'POST' && !originAllowed(request.headers.origin, port)) {
		sendError(response, 403, 'Origin is not allowed');
		return true;
	}

	switch (`${request.method ?? 'GET'} ${url.pathname}`) {
		case 'GET /api/snapshot': {
			sendSnapshot(response, service);
			return true;
		}
		case 'GET /api/status': {
			sendJson(response, 200, service.status);
			return true;
		}
		case 'GET /api/meta': {
			sendJson(response, 200, service.meta);
			return true;
		}
		case 'GET /api/jobs': {
			sendJson(response, 200, {jobs: service.jobs});
			return true;
		}
		case 'GET /api/analytics': {
			const requested = url.searchParams.get('window') ?? '24h';
			const window = WINDOWS.find((candidate) => candidate === requested);

			if (window === undefined) {
				sendError(response, 400, `Unsupported window: ${requested}`);
				return true;
			}

			sendJson(response, 200, service.analytics(window));
			return true;
		}
		case 'POST /api/jobs': {
			const body = await readBody(request);
			let parsed: unknown;

			try {
				parsed = JSON.parse(body);
			} catch {
				sendError(response, 400, 'Expected a JSON request body');
				return true;
			}

			const requestBody = JobRequestSchema.safeParse(parsed);

			if (!requestBody.success) {
				sendError(response, 400, 'Unsupported operation');
				return true;
			}

			const job = service.runOperation(requestBody.data.operation);
			sendJson(response, 202, {job});
			return true;
		}
		default: {
			sendError(response, 404, 'Unknown API route');
			return true;
		}
	}
};

/**
 * Starts the loopback-only console HTTP server.
 *
 * @param options - Service, bearer token, static bundle, bind address, and logger.
 * @returns Bound URL and a close function.
 */
export const startConsoleServer = async (options: ConsoleServerOptionsType): Promise<ConsoleServerHandleType> => {
	if (!isLoopbackHost(options.host)) {
		throw new Error(`Console may bind only to loopback, received ${options.host}`);
	}

	const server = createServer((request, response) => {
		const {host} = request.headers;

		if (!isLoopbackHost(host)) {
			sendError(response, 403, 'Host is not allowed');
			return;
		}

		const url = new URL(request.url ?? '/', `http://${host}`);

		if (!url.pathname.startsWith('/api/')) {
			serveStatic(response, options.staticRoot, url.pathname);
			return;
		}

		const authorization = request.headers.authorization ?? '';
		const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
		const candidate = bearer;

		if (!tokenMatches(options.token, candidate)) {
			sendError(response, 401, 'Missing or invalid console token');
			return;
		}

		void (async (): Promise<void> => {
			try {
				const handled = await handleApi({request, response, url, service: options.service, port: options.port});

				if (!handled) {
					serveStatic(response, options.staticRoot, url.pathname);
				}
			} catch (error: unknown) {
				options.logger.error('console_request_failed', {message: error instanceof Error ? error.message : String(error)});
				sendError(response, 500, 'Console request failed');
			}
		})();
	});

	server.listen(options.port, options.host);
	await once(server, 'listening');

	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : options.port;
	const host = options.host === '::1' ? '[::1]' : options.host;

	return {
		url: `http://${host}:${port}/`,
		port,
		close: async (): Promise<void> => {
			server.close();
			await once(server, 'close');
		},
	};
};
