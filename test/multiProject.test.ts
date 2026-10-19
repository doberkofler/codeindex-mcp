import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {CodeIndexError} from '../src/core/errors/errors.ts';
import {buildGeneration} from '../src/core/generation/buildGeneration.ts';
import {createFixtureIndex, silentLogger, type FixtureContextType, type FixtureProjectType} from './helpers/fixture.ts';

const PROJECTS: readonly FixtureProjectType[] = [
	{name: 'browser', project: 'tsconfig.json'},
	{name: 'contracts', project: 'contracts/tsconfig.json'},
	{name: 'server', project: 'server/tsconfig.json'},
];

describe('multiple TypeScript project contexts', () => {
	let fixture: FixtureContextType | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it('indexes the union of all project files into one generation', () => {
		fixture = createFixtureIndex('multi-project', PROJECTS);

		expect(fixture.index.getStatus().counts.files).toBe(3);
		expect(fixture.index.getStatus().scope.projects.map((project) => project.name)).toStrictEqual(['browser', 'contracts', 'server']);
		expect(fixture.index.getOutline({path: 'server/src/routes.ts', limit: 10}).items.map((item) => item.name)).toContain('route');
		expect(fixture.index.getOutline({path: 'contracts/src/service.ts', limit: 10}).items.map((item) => item.name)).toContain('ServiceRequest');
	});

	it('records every context that produced a shared declaration', () => {
		fixture = createFixtureIndex('multi-project', PROJECTS);
		const symbol = fixture.index.findSymbols({query: 'ServiceRequest', limit: 10}).items.at(0);

		expect(symbol).toMatchObject({name: 'ServiceRequest', kind: 'type', path: 'contracts/src/service.ts'});
		expect(symbol?.contexts).toStrictEqual(['browser', 'contracts', 'server']);
		expect(fixture.index.findSymbols({query: 'ServiceRequest', context: 'server', limit: 10}).items).toHaveLength(1);
	});

	it('keeps references associated with the context that resolved them', () => {
		fixture = createFixtureIndex('multi-project', PROJECTS);
		const symbol = fixture.index.findSymbols({query: 'ServiceRequest', limit: 1}).items.at(0);

		if (symbol === undefined) {
			throw new Error('Expected ServiceRequest symbol');
		}

		const references = fixture.index.findReferences({symbolId: symbol.id, limit: 100});
		const clientReference = references.items.find((item) => item.path === 'src/client.ts');
		const routeReference = references.items.find((item) => item.path === 'server/src/routes.ts');

		expect(clientReference).toMatchObject({role: 'reference', contexts: ['browser']});
		expect(routeReference).toMatchObject({role: 'reference', contexts: ['server']});
		expect(references.items.every((item) => item.contexts.length > 0)).toBe(true);
	});

	it('filters dependency usage by project context', () => {
		fixture = createFixtureIndex('multi-project', PROJECTS);

		const all = fixture.index.findDependencies({target: 'shared-package', limit: 10});
		const server = fixture.index.findDependencies({target: 'shared-package', context: 'server', limit: 10});

		expect(all.items.map((item) => item.path)).toStrictEqual(['server/src/routes.ts', 'src/client.ts']);
		expect(server.items.map((item) => item.path)).toStrictEqual(['server/src/routes.ts']);
		expect(fixture.index.findDependencies({target: 'shared-package', context: 'contracts', limit: 10}).items).toHaveLength(0);
	});

	it('retains the previous generation when one context fails', () => {
		const current = createFixtureIndex('multi-project', PROJECTS);
		fixture = current;
		const published = current.index.getStatus().generationId;
		writeFileSync(path.join(current.config.rootDir, 'server', 'tsconfig.json'), '{"compilerOptions":', 'utf8');

		expect(() => buildGeneration({config: current.config, database: current.database, logger: silentLogger, force: true})).toThrow(/configuration/u);

		expect(current.index.getStatus().generationId).toBe(published);
	});

	it('filters references and symbols by project context', () => {
		fixture = createFixtureIndex('multi-project', PROJECTS);
		const symbol = fixture.index.findSymbols({query: 'ServiceRequest', limit: 1}).items.at(0);

		if (symbol === undefined) {
			throw new Error('Expected ServiceRequest symbol');
		}

		const serverReferences = fixture.index.findReferences({symbolId: symbol.id, context: 'server', limit: 100});

		expect([...new Set(serverReferences.items.map((item) => item.path))]).toStrictEqual(['contracts/src/service.ts', 'server/src/routes.ts']);
		expect(serverReferences.items.some((item) => item.path === 'src/client.ts')).toBe(false);
		expect(serverReferences.items.every((item) => item.contexts.includes('server'))).toBe(true);
		expect(() => fixture?.index.findReferences({symbolId: symbol.id, context: 'missing', limit: 10})).toThrow(CodeIndexError);
		expect(() => fixture?.index.findSymbols({query: 'ServiceRequest', context: 'missing', limit: 10})).toThrow(CodeIndexError);
	});
});
