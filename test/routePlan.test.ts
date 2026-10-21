import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {loadRoutePlan, routePlanHashOf, routePlanOf, validateRoutePlan, type RouteType} from '../evaluation/harness/src/routePlan.ts';
import {loadSuite} from '../evaluation/harness/src/suite.ts';

const evaluationRoot = path.resolve(import.meta.dirname, '..', 'evaluation');
const releasePlanPath = path.join(evaluationRoot, 'routes', 'codeindex-release.json');
const releaseSuitePath = path.join(evaluationRoot, 'suites', 'release.json');

const routeOf = (routes: readonly RouteType[], caseId: string): RouteType => {
	const route = routes.find((item) => item.caseId === caseId);

	if (route === undefined) {
		throw new Error(`missing route for ${caseId}`);
	}

	return route;
};

describe('model-free route plan', () => {
	it('declares every complete route for the frozen release cases', () => {
		const plan = loadRoutePlan(releasePlanPath);
		const {suite, cases} = loadSuite(releaseSuitePath);

		validateRoutePlan(plan, suite, cases);
		expect(plan.routes).toHaveLength(18);

		for (const route of plan.routes) {
			expect(route.text.length).toBeGreaterThan(0);
			expect(route.codeindex.length).toBeGreaterThan(0);
			expect(route.text.some((step) => step.collect)).toBe(true);
			expect(route.codeindex.some((step) => (step.kind === 'mcp' ? step.collect !== 'none' : step.collect))).toBe(true);
		}

		const semantic = cases.filter((testCase) => testCase.class === 'semantic');

		expect(semantic).toHaveLength(6);

		for (const testCase of semantic) {
			expect(routeOf(plan.routes, testCase.id).projectFile).toBe('evaluation/fixtures/controlled-typescript/tsconfig.json');
		}
	});

	it('hashes the full declared route so a step change invalidates comparison identity', () => {
		const plan = loadRoutePlan(releasePlanPath);
		const loaded = routePlanOf(JSON.parse(readFileSync(releasePlanPath, 'utf8')) as unknown);
		const first = routeOf(plan.routes, 'locate-schema-version');
		const anchor = first.text.find((step) => step.kind === 'search');

		if (anchor === undefined) {
			throw new Error('the first route must contain a text search step');
		}

		const changed: RouteType = {
			...first,
			text: first.text.map((step) => (step.id === anchor.id && step.kind === 'search' ? {...step, pattern: 'a-different-pattern'} : step)),
		};
		const changedRoutes = plan.routes.map((route) => (route.caseId === first.caseId ? changed : route));

		expect(routePlanHashOf(loaded)).toBe(routePlanHashOf(plan));
		expect(routePlanHashOf({...plan, routes: changedRoutes})).not.toBe(routePlanHashOf(plan));
	});

	it('rejects a plan that omits a frozen case', () => {
		const plan = loadRoutePlan(releasePlanPath);
		const {suite, cases} = loadSuite(releaseSuitePath);
		const incomplete = {...plan, routes: plan.routes.slice(1)};

		expect(() => {
			validateRoutePlan(incomplete, suite, cases);
		}).toThrow(/exactly the 18 suite cases/u);
	});
});
