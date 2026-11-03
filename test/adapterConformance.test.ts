import {describe, expect, it} from 'vitest';
import {type AdapterBuildType, type AdapterModuleType, type AdapterType, type ScanResultType} from '@codeindex/adapter-sdk';
import {runAdapterConformance} from '@codeindex/adapter-sdk/conformance';
import {codeIndexAdapter as oracleAdapter} from '@codeindex/adapter-oracle/index';
import {codeIndexAdapter as typeScriptAdapter} from '@codeindex/adapter-typescript/index';

const emptyScan = (): ScanResultType => ({
	rootDir: '',
	projectId: '',
	extractorId: 'async-fixture',
	extractorVersion: '1.0.0',
	compilerVersion: 'none',
	declaredCompilerVersion: null,
	compilerDrift: false,
	files: [],
	sourceHash: '',
	configHash: '',
	projects: [],
	projectFileCount: 0,
	excludedFileCount: 0,
	configDiagnosticCount: 0,
	scanMs: 0,
});

const emptyBuild = (): AdapterBuildType => ({
	files: [],
	symbols: [],
	bindings: [],
	bindingContexts: [],
	bindingSites: [],
	surfaceOrigins: [],
	occurrences: [],
	dependencies: {edges: [], bindings: []},
	adapterStats: [],
	diagnostics: [],
	compilerMs: 0,
	extractionMs: 0,
});

const asyncAdapter = (): AdapterType => ({
	id: 'async-fixture',
	version: '1.0.0',
	displayName: 'Async fixture',
	discoveryText: 'fixture',
	sourceExtensions: ['.fixture'],
	ignoredSegments: [],
	limitations: [],
	scan: async (): Promise<ScanResultType> => {
		const scan = emptyScan();
		await Promise.resolve();
		return scan;
	},
	build: async (): Promise<AdapterBuildType> => {
		const build = emptyBuild();
		await Promise.resolve();
		return build;
	},
	configFiles: (): readonly string[] => [],
	isSourceFile: (): boolean => true,
});

describe('adapter SDK conformance', () => {
	it('accepts both official adapter modules', () => {
		for (const module of [typeScriptAdapter, oracleAdapter]) {
			const result = runAdapterConformance(module);

			expect(result.failures).toStrictEqual([]);
			expect(result.ok).toBe(true);
		}
	});

	it('accepts an asynchronous third-party adapter surface', () => {
		const module: AdapterModuleType = {
			manifest: {protocolVersion: 1, id: 'async-fixture', implementationVersion: '1.0.0', displayName: 'Async fixture'},
			create: asyncAdapter,
		};

		expect(runAdapterConformance(module).ok).toBe(true);
	});

	it('reports a shared factory instance and an identity mismatch', () => {
		const shared = asyncAdapter();
		const module: AdapterModuleType = {
			manifest: {protocolVersion: 1, id: 'other', implementationVersion: '1.0.0', displayName: 'Broken'},
			create: (): AdapterType => shared,
		};
		const result = runAdapterConformance(module);

		expect(result.ok).toBe(false);
		expect(result.failures.map((failure) => failure.check)).toContain('factory');
		expect(result.failures.map((failure) => failure.check)).toContain('identity');
	});
});
