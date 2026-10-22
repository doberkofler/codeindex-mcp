import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {type McpCallOutcomeType, type McpSessionType} from './routeClient.ts';
import {type RouteRunType} from './route.ts';

export const tempWorkspace = (): string => mkdtempSync(path.join(os.tmpdir(), 'codeindex-route-'));

export const writeFile = (workspace: string, relative: string, text: string): void => {
	const file = path.join(workspace, relative);

	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, text, 'utf8');
};

export const outcomeOf = (data: unknown, overrides: Partial<McpCallOutcomeType> = {}): McpCallOutcomeType => ({
	tool: 'find_symbol',
	status: 'ok',
	elapsedMs: 1,
	coreMs: 1,
	responseBytes: 10,
	text: '',
	structured: data,
	errorCode: null,
	errorMessage: null,
	...overrides,
});

export const sessionOf = (call: McpSessionType['callTool']): McpSessionType => ({
	serverName: 'fixture',
	serverVersion: '1',
	startupMs: 1,
	callTool: call,
	close: (): void => undefined,
});

export const baseRunOf = (coreMs: number | null, callCount: number): Pick<RouteRunType, 'valid' | 'exact' | 'metrics'> => ({
	valid: true,
	exact: true,
	metrics: {
		callCount,
		responseBytes: callCount * 10,
		elapsedMs: callCount * 2,
		coreMs: coreMs === null ? {value: null, state: 'unavailable' as const} : {value: coreMs, state: 'exact' as const},
	},
});

export const runOf = (
	caseId: string,
	treatment: 'accepted' | 'candidate' | 'no-index',
	exact: boolean,
	core: 'exact' | 'unavailable' = 'exact',
): RouteRunType => ({
	caseId,
	treatment,
	answerFiles: exact ? ['src/a.ts'] : ['src/b.ts'],
	expectedFiles: ['src/a.ts'],
	exact,
	valid: true,
	calls: [],
	metrics: {
		callCount: 1,
		responseBytes: 10,
		elapsedMs: 2,
		coreMs: core === 'exact' ? {value: 1, state: 'exact' as const} : {value: null, state: 'unavailable' as const},
	},
	defects: [],
});
