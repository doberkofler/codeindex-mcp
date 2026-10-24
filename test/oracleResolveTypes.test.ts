import {describe, expect, it} from 'vitest';
import {OracleDiagnosticCollector} from '../src/adapters/oracle/diagnostics.ts';
import {type ChoiceCandidateType, type ResolutionType, type ResolveStateType} from '../src/adapters/oracle/resolveReferences.ts';
import {filterByTypes, type ResolutionServicesType} from '../src/adapters/oracle/resolveTypes.ts';
import {type OracleNamePartType, type OracleNameType} from '../src/adapters/oracle/name.ts';
import {type OracleDeclarationType, type OracleParameterType, type OracleReferenceSiteType} from '../src/adapters/oracle/syntax.ts';

type SpecType = Readonly<{
	kind: OracleDeclarationType['kind'];
	name: string;
	type?: string;
	anchored?: boolean;
	rowType?: boolean;
	parameters?: readonly OracleParameterType[];
}>;

const range = (offset = 0): OracleDeclarationType['range'] => ({
	startOffset: offset,
	endOffset: offset + 1,
	startLine: 1,
	startColumn: offset + 1,
	endLine: 1,
	endColumn: offset + 2,
});

const part = (canonical: string): OracleNamePartType => ({canonical, quoted: false, text: canonical.toLowerCase()});

const nameOf = (canonical: string): OracleNameType => {
	const parts = canonical.split('.').map((value) => part(value));
	return {parts, text: canonical.toLowerCase(), canonical: parts.map((item) => item.canonical).join('.')};
};

const typeReferenceOf = (
	canonical: string,
	options: Readonly<{anchored?: boolean; rowType?: boolean}> = {},
): Readonly<{name: OracleNameType; range: OracleDeclarationType['range']; anchored: boolean; rowType: boolean}> => ({
	name: nameOf(canonical),
	range: range(),
	anchored: options.anchored ?? false,
	rowType: options.rowType ?? false,
});

const parameterOf = (
	name: string,
	type: string | null,
	options: Readonly<{mode?: OracleParameterType['mode']; anchored?: boolean; rowType?: boolean; hasDefault?: boolean}> = {},
): OracleParameterType => ({
	name: part(name),
	nameRange: range(),
	range: range(),
	mode: options.mode ?? 'IN',
	hasDefault: options.hasDefault ?? false,
	typeText: type ?? '',
	typeReferences: type === null ? [] : [typeReferenceOf(type, options)],
});

const declarationOf = (spec: SpecType): OracleDeclarationType => ({
	kind: spec.kind,
	name: part(spec.name),
	range: range(),
	nameRange: range(),
	parent: null,
	unit: 0,
	exported: true,
	parameters: spec.parameters ?? [],
	typeReferences: spec.type === undefined ? [] : [typeReferenceOf(spec.type, spec)],
});

const environmentOf = (
	specs: readonly SpecType[],
): Readonly<{state: ResolveStateType; idOf: (name: string) => string; declarationNamed: (name: string) => OracleDeclarationType}> => {
	const declarations = specs.map((spec) => declarationOf(spec));
	const ids = new Map(declarations.map((declaration, index) => [declaration.name.canonical, `symbol-${String(index)}`]));
	const file = {
		path: 'types.pks',
		parse: {units: [], declarations, references: [], dependencies: [], diagnostics: []},
		graph: {canonicals: [], signatures: [], childrenByParent: new Map()},
		bindings: declarations.map((declaration, index) => ({
			canonical: declaration.name.canonical,
			signature: '',
			heading: '',
			symbolId: `symbol-${String(index)}`,
			definitionOnly: false,
			mapped: false,
			enclosingId: null,
		})),
	};
	const state: ResolveStateType = {
		input: {context: 'APP', defaultSchema: 'APP', files: [file], packages: new Map()},
		fileIndex: 0,
		file,
		symbolDeclarations: new Map(declarations.map((_declaration, index) => [`symbol-${String(index)}`, {fileIndex: 0, declarationIndex: index}])),
		diagnostics: new OracleDiagnosticCollector('types.pks'),
	};
	const idOf = (name: string): string => ids.get(name) ?? '';
	const declarationNamed = (name: string): OracleDeclarationType => {
		const declaration = declarations.find((candidate) => candidate.name.canonical === name);

		if (declaration === undefined) {
			throw new Error(`Missing declaration ${name}`);
		}

		return declaration;
	};

	return {state, idOf, declarationNamed};
};

const siteOf = (argumentsWithValues: NonNullable<OracleReferenceSiteType['arguments']> = []): OracleReferenceSiteType => ({
	name: nameOf('RUN'),
	range: range(),
	nameRange: range(),
	unit: 0,
	enclosing: 0,
	kind: 'call',
	argumentCount: argumentsWithValues.length,
	argumentNames: argumentsWithValues.flatMap((argument) => (argument.name === null ? [] : [argument.name])),
	arguments: argumentsWithValues,
	rowType: false,
});

const argumentOf = (
	value: string,
	options: Readonly<{literalType?: string; indexed?: boolean; name?: string | null}> = {},
): NonNullable<OracleReferenceSiteType['arguments']>[number] => ({
	range: range(),
	name: options.name ?? null,
	...(options.literalType === undefined ? {leadName: nameOf(value)} : {literalType: options.literalType}),
	indexed: options.indexed ?? false,
});

const servicesOf = (aliases: Readonly<Record<string, string>> = {}, memberResult: string | null = null): ResolutionServicesType => ({
	resolveSimpleAt: (_state, _start, canonical): ResolutionType => ({symbolId: aliases[canonical] ?? null, outcome: 'resolved'}),
	resolveMember: (): string | null => memberResult,
	resolveSite: (): ResolutionType => ({symbolId: null, outcome: 'no-declaration'}),
	syntheticSite: () => siteOf(),
});

const candidateOf = (id: string, declaration: OracleDeclarationType, path = 'types.pks'): ChoiceCandidateType => ({
	symbolId: id,
	kind: declaration.kind,
	declaration,
	path,
});

describe('Oracle type filtering by literal types', () => {
	it('matches exact types, type equivalents, JSON inheritance, and families', () => {
		const environment = environmentOf([{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'VARCHAR2')]}]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));

		expect(
			filterByTypes(servicesOf(), environment.state, [candidate], {site: siteOf([argumentOf('X', {literalType: 'VARCHAR2'})]), exact: true}),
		).toStrictEqual([candidate]);
		expect(filterByTypes(servicesOf(), environment.state, [candidate], {site: siteOf([argumentOf('X', {literalType: 'VARCHAR'})]), exact: true})).toStrictEqual(
			[candidate],
		);
		expect(filterByTypes(servicesOf(), environment.state, [candidate], {site: siteOf([argumentOf('X', {literalType: 'NUMBER'})]), exact: false})).toStrictEqual(
			[],
		);

		const jsonEnvironment = environmentOf([{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'JSON_ELEMENT_T')]}]);
		const jsonCandidate = candidateOf(jsonEnvironment.idOf('RUN'), jsonEnvironment.declarationNamed('RUN'));

		expect(
			filterByTypes(servicesOf(), jsonEnvironment.state, [jsonCandidate], {site: siteOf([argumentOf('X', {literalType: 'JSON_OBJECT_T'})]), exact: true}),
		).toStrictEqual([jsonCandidate]);

		const numericEnvironment = environmentOf([{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'NUMBER')]}]);
		const numericCandidate = candidateOf(numericEnvironment.idOf('RUN'), numericEnvironment.declarationNamed('RUN'));

		expect(
			filterByTypes(servicesOf(), numericEnvironment.state, [numericCandidate], {site: siteOf([argumentOf('X', {literalType: 'PLS_INTEGER'})]), exact: false}),
		).toStrictEqual([numericCandidate]);
		expect(
			filterByTypes(servicesOf(), numericEnvironment.state, [numericCandidate], {site: siteOf([argumentOf('X', {literalType: 'PLS_INTEGER'})]), exact: true}),
		).toStrictEqual([]);
	});
});

describe('Oracle symbolic type filtering', () => {
	it('resolves subtype aliases and named associations', () => {
		const environment = environmentOf([
			{kind: 'subtype', name: 'MONEY', type: 'NUMBER'},
			{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'MONEY'), parameterOf('P_B', 'VARCHAR2')]},
		]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));
		const services = servicesOf({MONEY: environment.idOf('MONEY')});
		const site = siteOf([argumentOf('L_VALUE', {literalType: 'NUMBER', name: 'P_B'}), argumentOf('L_TEXT', {literalType: 'VARCHAR2', name: 'P_A'})]);

		expect(filterByTypes(services, environment.state, [candidate], {site, exact: false})).toStrictEqual([]);

		const compatible = siteOf([argumentOf('L_AMOUNT', {literalType: 'NUMBER', name: 'P_A'}), argumentOf('L_TEXT', {literalType: 'VARCHAR2', name: 'P_B'})]);

		expect(filterByTypes(services, environment.state, [candidate], {site: compatible, exact: false})).toStrictEqual([candidate]);
	});

	it('resolves a collection element type through nested collection aliases', () => {
		const environment = environmentOf([
			{kind: 'subtype', name: 'NUMBER_ALIAS', type: 'NUMBER'},
			{kind: 'collection_type', name: 'INNER_ROWS', type: 'NUMBER_ALIAS'},
			{kind: 'collection_type', name: 'OUTER_ROWS', type: 'INNER_ROWS'},
			{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'NUMBER')]},
		]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));
		const services: ResolutionServicesType = {
			...servicesOf({
				NUMBER_ALIAS: environment.idOf('NUMBER_ALIAS'),
				INNER_ROWS: environment.idOf('INNER_ROWS'),
			}),
			resolveSite: () => ({symbolId: environment.idOf('OUTER_ROWS'), outcome: 'resolved'}),
		};

		expect(filterByTypes(services, environment.state, [candidate], {site: siteOf([argumentOf('L_ROWS', {indexed: true})]), exact: false})).toStrictEqual([
			candidate,
		]);
	});

	it('falls back to the collection identity when the element type is unknown', () => {
		const environment = environmentOf([
			{kind: 'collection_type', name: 'ROWS', type: 'UNKNOWN'},
			{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'UNKNOWN')]},
		]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));
		const services: ResolutionServicesType = {
			...servicesOf({ROWS: environment.idOf('ROWS')}),
			resolveSite: () => ({symbolId: environment.idOf('ROWS'), outcome: 'resolved'}),
		};

		expect(filterByTypes(services, environment.state, [candidate], {site: siteOf([argumentOf('L_ROWS', {indexed: true})]), exact: false})).toStrictEqual([
			candidate,
		]);
	});

	it('stops recursive alias expansion and keeps unknown references', () => {
		const specs: readonly SpecType[] = [
			{kind: 'subtype', name: 'A', type: 'B'},
			{kind: 'subtype', name: 'B', type: 'C'},
			{kind: 'subtype', name: 'C', type: 'D'},
			{kind: 'subtype', name: 'D', type: 'E'},
			{kind: 'subtype', name: 'E', type: 'F'},
			{kind: 'subtype', name: 'F', type: 'NUMBER'},
			{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'A'), parameterOf('P_B', 'APP.CUSTOM'), parameterOf('P_C', 'UNKNOWN')]},
		];
		const environment = environmentOf(specs);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));
		const services = servicesOf({
			A: environment.idOf('A'),
			B: environment.idOf('B'),
			C: environment.idOf('C'),
			D: environment.idOf('D'),
			E: environment.idOf('E'),
			F: environment.idOf('F'),
		});

		expect(filterByTypes(services, environment.state, [candidate], {site: siteOf([argumentOf('L_A', {literalType: 'NUMBER'})]), exact: false})).toStrictEqual(
			[],
		);
		expect(filterByTypes(services, environment.state, [candidate], {site: siteOf([argumentOf('L_A', {literalType: 'A'})]), exact: false})).toStrictEqual([
			candidate,
		]);
		expect(filterByTypes(services, environment.state, [candidate], {site: siteOf([argumentOf('L_A', {literalType: 'VARCHAR2'})]), exact: false})).toStrictEqual(
			[],
		);
	});
});

describe('Oracle type filtering exclusions', () => {
	it('ignores OUT, anchored, rowtype, untyped, and unresolved parameters', () => {
		const environment = environmentOf([
			{
				kind: 'procedure',
				name: 'RUN',
				parameters: [
					parameterOf('P_OUT', 'NUMBER', {mode: 'OUT'}),
					parameterOf('P_ANCHOR', 'NUMBER', {anchored: true}),
					parameterOf('P_ROW', 'NUMBER', {rowType: true}),
					parameterOf('P_NONE', null),
					parameterOf('P_MULTI', 'APP.CUSTOM'),
					parameterOf('P_EMPTY', ''),
				],
			},
		]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));
		const site = siteOf([
			argumentOf('L_OUT', {literalType: 'VARCHAR2'}),
			argumentOf('L_ANCHOR', {literalType: 'VARCHAR2'}),
			argumentOf('L_ROW', {literalType: 'VARCHAR2'}),
			argumentOf('L_NONE', {literalType: 'VARCHAR2'}),
			argumentOf('L_MULTI', {literalType: 'CUSTOM'}),
			argumentOf('L_EMPTY', {literalType: 'VARCHAR2'}),
		]);

		expect(filterByTypes(servicesOf(), environment.state, [candidate], {site, exact: false})).toStrictEqual([candidate]);
	});

	it('keeps a candidate when an argument has no resolvable name', () => {
		const environment = environmentOf([{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'NUMBER')]}]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));
		const unknown = {range: range(), name: null, leadName: nameOf('L_UNKNOWN'), indexed: false};

		expect(filterByTypes(servicesOf(), environment.state, [candidate], {site: siteOf([unknown]), exact: false})).toStrictEqual([candidate]);
	});

	it('keeps a candidate when its own declaration cannot be located', () => {
		const environment = environmentOf([{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'MONEY')]}]);
		const candidate = candidateOf('missing-symbol', environment.declarationNamed('RUN'));

		expect(
			filterByTypes(servicesOf(), environment.state, [candidate], {site: siteOf([argumentOf('L_VALUE', {literalType: 'MONEY'})]), exact: false}),
		).toStrictEqual([candidate]);
	});

	it('returns no candidates when the argument list is empty', () => {
		const environment = environmentOf([{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'NUMBER')]}]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));

		expect(filterByTypes(servicesOf(), environment.state, [candidate], {site: siteOf(), exact: true})).toStrictEqual([candidate]);
	});
});

describe('Oracle remaining type-resolution paths', () => {
	it('returns a symbolic identity for an unindexed named argument', () => {
		const environment = environmentOf([
			{kind: 'subtype', name: 'MONEY', type: 'NUMBER'},
			{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'NUMBER')]},
		]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));
		const services: ResolutionServicesType = {
			...servicesOf({MONEY: environment.idOf('MONEY')}),
			resolveSite: () => ({symbolId: environment.idOf('MONEY'), outcome: 'resolved'}),
		};

		expect(filterByTypes(services, environment.state, [candidate], {site: siteOf([argumentOf('L_AMOUNT')]), exact: false})).toStrictEqual([candidate]);
	});

	it('maps named and positional arguments past already supplied parameters', () => {
		const environment = environmentOf([
			{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'NUMBER'), parameterOf('P_B', 'VARCHAR2'), parameterOf('P_C', 'NUMBER')]},
		]);
		const candidate = candidateOf(environment.idOf('RUN'), environment.declarationNamed('RUN'));
		const site = siteOf([
			argumentOf('L_A', {literalType: 'NUMBER'}),
			argumentOf('L_B', {literalType: 'VARCHAR2', name: 'P_B'}),
			argumentOf('L_C', {literalType: 'NUMBER'}),
		]);

		expect(filterByTypes(servicesOf(), environment.state, [candidate], {site, exact: false})).toStrictEqual([candidate]);
	});

	it('uses the written parameter canonical when its declaration file is missing', () => {
		const environment = environmentOf([{kind: 'procedure', name: 'RUN', parameters: [parameterOf('P_A', 'MONEY')]}]);
		const candidate = candidateOf('external-symbol', environment.declarationNamed('RUN'));
		const state = {
			...environment.state,
			symbolDeclarations: new Map([...environment.state.symbolDeclarations, ['external-symbol', {fileIndex: 99, declarationIndex: 0}]]),
		};

		expect(filterByTypes(servicesOf(), state, [candidate], {site: siteOf([argumentOf('L_VALUE', {literalType: 'MONEY'})]), exact: false})).toStrictEqual([
			candidate,
		]);
	});
});
