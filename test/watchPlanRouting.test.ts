import {describe, expect, it} from 'vitest';

import {parseAdapterWatchPlan, type AdapterWatchPlanType} from '@codeindex/adapter-sdk';

import {routeWatchEvent, routeWatchFailure} from '../src/core/freshness/workspaceWatcher.ts';

const oraclePlan: AdapterWatchPlanType = {
	adapterId: 'oracle',
	adapterVersion: '0.5.0',
	planVersion: 1,
	planId: 'oracle-plan',
	knownSourceFiles: ['database/source/demo.pkb'],
	inputFiles: ['oracle-project.json'],
	scopes: [
		{
			candidateRoots: ['database'],
			includeRules: [{kind: 'glob', pattern: 'database/**/*.pkb'}],
			excludeRules: [{kind: 'prefix', path: 'database/generated'}],
			sourceRules: [{kind: 'suffix', suffix: '.pkb'}],
		},
	],
};

const typescriptPlan: AdapterWatchPlanType = {
	adapterId: 'typescript',
	adapterVersion: '0.3.0',
	planVersion: 1,
	planId: 'typescript-plan',
	knownSourceFiles: ['src/main.ts', 'shared/imported.ts'],
	inputFiles: ['tsconfig.json', 'package.json', 'pnpm-lock.yaml'],
	scopes: [
		{
			candidateRoots: ['src'],
			includeRules: [{kind: 'glob', pattern: 'src/**/*'}],
			excludeRules: [
				{kind: 'segment', segment: 'generated'},
				{kind: 'suffix', suffix: '.d.ts'},
				{kind: 'suffix', suffix: '.d.mts'},
				{kind: 'suffix', suffix: '.d.cts'},
			],
			sourceRules: [
				{kind: 'suffix', suffix: '.ts'},
				{kind: 'suffix', suffix: '.tsx'},
			],
		},
	],
};

const sharedRootPlan: AdapterWatchPlanType = {
	...oraclePlan,
	adapterId: 'shared-root',
	adapterVersion: '1.0.0',
	planId: 'shared-root-plan',
	scopes: [
		{
			candidateRoots: ['shared'],
			includeRules: [{kind: 'glob', pattern: 'shared/**/*'}],
			excludeRules: [],
			sourceRules: [{kind: 'suffix', suffix: '.sql'}],
		},
	],
};

describe('watch-plan routing', () => {
	it('does not refresh Oracle for a generated file excluded by its plan', () => {
		expect(routeWatchEvent([oraclePlan], 'add', 'database/generated/demo.pkb')).toBeNull();
	});

	it('keeps TypeScript declaration policy in the adapter plan', () => {
		expect(routeWatchEvent([typescriptPlan], 'change', 'src/types.d.ts')).toBeNull();
		expect(routeWatchEvent([typescriptPlan], 'change', 'src/main.ts')).toStrictEqual({
			paths: ['src/main.ts'],
			adapterIds: ['typescript'],
		});
	});

	it('does not let a source suffix bypass candidate roots or include/exclude rules', () => {
		expect(routeWatchEvent([typescriptPlan], 'add', 'outside/new.ts')).toBeNull();
		expect(routeWatchEvent([typescriptPlan], 'add', 'src/generated/new.ts')).toBeNull();
		expect(routeWatchEvent([typescriptPlan], 'add', 'src/new.ts')).toStrictEqual({
			paths: ['src/new.ts'],
			adapterIds: ['typescript'],
		});
	});

	it('attributes exact known sources and non-source inputs regardless of suffix', () => {
		expect(routeWatchEvent([typescriptPlan], 'change', 'shared/imported.ts')).toStrictEqual({
			paths: ['shared/imported.ts'],
			adapterIds: ['typescript'],
		});
		expect(routeWatchEvent([typescriptPlan], 'change', 'pnpm-lock.yaml')).toStrictEqual({
			paths: null,
			adapterIds: ['typescript'],
		});
	});

	it('attributes directory events only to intersecting adapter candidate spaces', () => {
		expect(routeWatchEvent([typescriptPlan, oraclePlan], 'addDir', 'src/nested')).toStrictEqual({
			paths: null,
			adapterIds: ['typescript'],
		});
		expect(routeWatchEvent([typescriptPlan, oraclePlan], 'unlinkDir', 'database/source')).toStrictEqual({
			paths: null,
			adapterIds: ['oracle'],
		});
	});

	it('attributes a directory event to adapters with nested exact files', () => {
		expect(routeWatchEvent([typescriptPlan, sharedRootPlan], 'unlinkDir', 'shared')).toStrictEqual({
			paths: null,
			adapterIds: ['shared-root', 'typescript'],
		});
	});

	it('deduplicates adapter attribution when plans share a candidate root', () => {
		const second = {...typescriptPlan, adapterId: 'typed-js', adapterVersion: '1.0.0', planId: 'typed-js-plan'};

		expect(routeWatchEvent([typescriptPlan, second], 'add', 'src/new.ts')).toStrictEqual({
			paths: ['src/new.ts'],
			adapterIds: ['typed-js', 'typescript'],
		});
	});

	it('scopes physical-root watcher failures and keeps unscoped failures conservative', () => {
		expect(routeWatchFailure([typescriptPlan, oraclePlan], 'src')).toStrictEqual({
			paths: null,
			adapterIds: ['typescript'],
		});
		expect(routeWatchFailure([typescriptPlan, oraclePlan], null)).toStrictEqual({
			paths: null,
			adapterIds: ['oracle', 'typescript'],
		});
		expect(routeWatchFailure([typescriptPlan, oraclePlan], 'pnpm-lock.yaml')).toStrictEqual({
			paths: null,
			adapterIds: ['typescript'],
		});
		expect(routeWatchFailure([typescriptPlan, oraclePlan], 'shared/imported.ts')).toStrictEqual({
			paths: null,
			adapterIds: ['typescript'],
		});
	});

	it('attributes a failed shared root to adapters with nested exact files', () => {
		expect(routeWatchFailure([typescriptPlan, sharedRootPlan], 'shared')).toStrictEqual({
			paths: null,
			adapterIds: ['shared-root', 'typescript'],
		});
	});

	it('invalidates only the owning adapter for an unclassified event inside its root', () => {
		expect(routeWatchEvent([typescriptPlan, oraclePlan], 'unknown', 'src/unclassified')).toStrictEqual({
			paths: null,
			adapterIds: ['typescript'],
		});
	});

	it('validates serialized plans and rejects absolute paths or unsupported plan versions', () => {
		expect(parseAdapterWatchPlan(structuredClone(typescriptPlan))).toStrictEqual(typescriptPlan);
		expect(() => parseAdapterWatchPlan({...typescriptPlan, knownSourceFiles: ['/private/source.ts']})).toThrow('Invalid input');
		expect(() => parseAdapterWatchPlan({...typescriptPlan, knownSourceFiles: ['C:/private/source.ts']})).toThrow('Invalid input');
		expect(() => parseAdapterWatchPlan({...typescriptPlan, planVersion: 2})).toThrow('Invalid input');
	});
});
