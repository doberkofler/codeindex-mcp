import {describe, expect, it} from 'vitest';
import {isBuildWorkerData, runBuildWorker} from '../src/core/generation/buildWorker.ts';
import {typeScriptExtractor} from '../src/adapters/typescript/index.ts';
import {createFixtureConfig} from './helpers/fixture.ts';

type MutablePayloadType = {
	kind: string;
	config: Record<string, unknown>;
	scan: Record<string, unknown>;
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
	scan: {
		sourceHash: 'source',
		configHash: 'config',
		files: [],
	},
	force: false,
	ownerId: 'owner',
	debug: false,
});

const invalidPayloads = (): readonly unknown[] => {
	const payloads: unknown[] = [null, 'payload', [], {}, {...validPayload(), kind: 'other'}, {...validPayload(), config: null}, {...validPayload(), scan: null}];

	for (const field of ['databasePath', 'rootDir', 'projectFilePath', 'projects', 'extractorId']) {
		const payload = validPayload();
		payload.config[field] = 42;
		payloads.push(payload);
	}

	for (const field of ['sourceHash', 'configHash', 'files']) {
		const payload = validPayload();
		payload.scan[field] = 42;
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

	it('reports build failures without a parent port', () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			const scan = typeScriptExtractor.scan(config, []);
			const payload = {
				kind: 'code-index-build' as const,
				config: {...config, databasePath: '/dev/null/index.sqlite'},
				scan,
				force: false,
				ownerId: 'owner',
				debug: false,
			};

			expect(() => {
				runBuildWorker(payload);
			}).not.toThrow();
		} finally {
			cleanup();
		}
	});
});
