import {describe, expect, it} from 'vitest';
import {isBuildWorkerData, runBuildWorker} from '../src/core/generation/buildWorker.ts';
import {typeScriptExtractor} from '@codeindex/adapter-typescript/index';
import {createCancellationBuffer} from '../src/core/generation/executionCancellation.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

const descriptors = [
	{
		id: 'typescript',
		moduleUrl: 'builtin:typescript',
		protocolVersion: 1,
		implementationVersion: typeScriptExtractor.version,
		packageName: '@codeindex/adapter-typescript',
		packageVersion: typeScriptExtractor.version,
	},
];

type MutablePayloadType = {
	kind: string;
	config: Record<string, unknown>;
	descriptors: readonly Record<string, unknown>[];
	adapterIds: readonly string[] | null;
	force: boolean;
	ownerId: string;
	cancellationBuffer: SharedArrayBuffer;
	debug: boolean;
};

const validPayload = (): MutablePayloadType => ({
	kind: 'code-index-build',
	config: {
		databasePath: '/tmp/index.sqlite',
		rootDir: '/repo',
		projectFilePath: '/repo/tsconfig.json',
		projects: [],
		extractorId: 'typescript',
	},
	descriptors,
	adapterIds: null,
	force: false,
	ownerId: 'owner',
	cancellationBuffer: createCancellationBuffer(),
	debug: false,
});

const invalidPayloads = (): readonly unknown[] => {
	const payloads: unknown[] = [
		null,
		'payload',
		[],
		{},
		{...validPayload(), kind: 'other'},
		{...validPayload(), config: null},
		{...validPayload(), adapterIds: 42},
	];

	for (const field of ['databasePath', 'rootDir', 'projectFilePath', 'projects', 'extractorId']) {
		const payload = validPayload();
		payload.config[field] = 42;
		payloads.push(payload);
	}

	for (const field of ['force', 'ownerId', 'cancellationBuffer']) {
		const payload = validPayload();
		Reflect.set(payload, field, 42);
		payloads.push(payload);
	}

	return payloads;
};

describe('build worker payload', () => {
	it('accepts the complete build payload', () => {
		expect(isBuildWorkerData(validPayload())).toBe(true);
	});

	it('rejects every incomplete payload shape', () => {
		for (const payload of invalidPayloads()) {
			expect(isBuildWorkerData(payload)).toBe(false);
		}
	});

	it('reports build failures as a bounded structured envelope', async () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			const payload = {
				kind: 'code-index-build' as const,
				config: {...config, databasePath: '/dev/null/index.sqlite'},
				adapterIds: null,
				descriptors,
				force: false,
				ownerId: 'owner',
				cancellationBuffer: createCancellationBuffer(),
				debug: false,
			};

			const message = await runBuildWorker(payload);

			expect(message).toMatchObject({
				ok: false,
				failure: {
					outcome: 'failed',
					cause: 'persistence',
					stage: 'persistence',
					project: null,
				},
			});
			expect(JSON.stringify(message)).not.toContain('/dev/null');
			expect(JSON.stringify(message)).not.toContain('stack');
		} finally {
			cleanup();
		}
	});
});
