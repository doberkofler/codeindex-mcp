import {describe, expect, it} from 'vitest';
import {isBuildWorkerData, runBuildWorker} from '../src/core/generation/buildWorker.ts';
import {typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

type MutablePayloadType = {
	kind: string;
	config: Record<string, unknown>;
	scans: [Record<string, unknown>, ...Record<string, unknown>[]];
	force: boolean;
	ownerId: string;
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
	scans: [
		{
			adapterId: 'typescript',
			coverage: 'present',
			absenceReason: null,
			scan: {
				sourceHash: 'source',
				configHash: 'config',
				files: [],
			},
		},
	],
	force: false,
	ownerId: 'owner',
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
		{...validPayload(), scans: null},
		{...validPayload(), scans: []},
	];

	for (const field of ['databasePath', 'rootDir', 'projectFilePath', 'projects', 'extractorId']) {
		const payload = validPayload();
		payload.config[field] = 42;
		payloads.push(payload);
	}

	for (const field of ['sourceHash', 'configHash', 'files']) {
		const payload = validPayload();
		const [plan] = payload.scans;

		(plan['scan'] as Record<string, unknown>)[field] = 42;
		payloads.push(payload);
	}

	for (const field of ['force', 'ownerId']) {
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

	it('reports build failures as a bounded structured envelope', () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			const scan = typeScriptExtractor.scan(config, []);
			const payload = {
				kind: 'code-index-build' as const,
				config: {...config, databasePath: '/dev/null/index.sqlite'},
				scans: [{adapterId: 'typescript', coverage: 'present' as const, absenceReason: null, scan}],
				force: false,
				ownerId: 'owner',
				debug: false,
			};

			const message = runBuildWorker(payload);

			expect(message).toMatchObject({
				ok: false,
				failure: {
					outcome: 'failed',
					cause: 'persistence',
					stage: 'persistence',
					project: {name: 'root', file: 'tsconfig.json'},
				},
			});
			expect(JSON.stringify(message)).not.toContain('/dev/null');
			expect(JSON.stringify(message)).not.toContain('stack');
		} finally {
			cleanup();
		}
	});
});
