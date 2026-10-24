import {describe, expect, it} from 'vitest';
import {OracleDiagnosticCollector} from '../src/adapters/oracle/diagnostics.ts';
import {chooseCandidateOf} from '../src/adapters/oracle/resolveCandidates.ts';
import {type ChoiceCandidateType, type ResolutionType, type ResolveStateType} from '../src/adapters/oracle/resolveReferences.ts';
import {type ResolutionServicesType} from '../src/adapters/oracle/resolveTypes.ts';
import {type OracleNamePartType, type OracleNameType} from '../src/adapters/oracle/name.ts';
import {type OracleDeclarationType, type OracleParameterType, type OracleReferenceSiteType} from '../src/adapters/oracle/syntax.ts';

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

const parameterOf = (
	canonical: string,
	options: Readonly<{mode?: OracleParameterType['mode']; hasDefault?: boolean; type?: string; anchored?: boolean; rowType?: boolean}> = {},
): OracleParameterType => ({
	name: part(canonical),
	nameRange: range(),
	range: range(),
	mode: options.mode ?? 'IN',
	hasDefault: options.hasDefault ?? false,
	typeText: options.type ?? 'NUMBER',
	typeReferences: [{name: nameOf(options.type ?? 'NUMBER'), range: range(), rowType: options.rowType ?? false, anchored: options.anchored ?? false}],
});

const declarationOf = (
	kind: string,
	name: string,
	options: Readonly<{parameters?: readonly OracleParameterType[]; type?: string; anchored?: boolean; rowType?: boolean; offset?: number}> = {},
): OracleDeclarationType => ({
	kind: kind as OracleDeclarationType['kind'],
	name: part(name),
	range: range(options.offset ?? 0),
	nameRange: range(options.offset ?? 0),
	parent: null,
	unit: 0,
	exported: true,
	parameters: options.parameters ?? [],
	typeReferences:
		options.type === undefined ? [] : [{name: nameOf(options.type), range: range(), rowType: options.rowType ?? false, anchored: options.anchored ?? false}],
});

const candidateOf = (
	symbolId: string,
	kind: string,
	name: string,
	options: Readonly<{parameters?: readonly OracleParameterType[]; path?: string; offset?: number; type?: string; anchored?: boolean; rowType?: boolean}> = {},
): ChoiceCandidateType => ({
	symbolId,
	kind,
	declaration: declarationOf(kind, name, options),
	path: options.path ?? 'a.pkb',
});

const siteOf = (
	site: Readonly<{
		kind?: OracleReferenceSiteType['kind'];
		arguments?: NonNullable<OracleReferenceSiteType['arguments']>;
		argumentCount?: number | null;
		argumentNames?: readonly string[];
		statementCall?: boolean;
		offset?: number;
	}> = {},
): OracleReferenceSiteType => ({
	name: nameOf('RUN'),
	range: range(site.offset ?? 0),
	nameRange: range(site.offset ?? 0),
	unit: 0,
	enclosing: 0,
	kind: site.kind ?? 'reference',
	argumentCount: site.argumentCount ?? null,
	argumentNames: site.argumentNames ?? [],
	...(site.arguments === undefined ? {} : {arguments: site.arguments}),
	rowType: false,
	...(site.statementCall === undefined ? {} : {statementCall: site.statementCall}),
});

const fileOf = (path = 'a.pkb'): ResolveStateType['file'] => ({
	path,
	parse: {units: [], declarations: [], references: [], dependencies: [], diagnostics: []},
	graph: {canonicals: [], signatures: [], childrenByParent: new Map()},
	bindings: [],
});

const stateOf = (diagnostics = new OracleDiagnosticCollector('a.pkb')): ResolveStateType => ({
	input: {context: 'APP', defaultSchema: 'APP', files: [], packages: new Map()},
	fileIndex: 0,
	file: fileOf(),
	symbolDeclarations: new Map(),
	diagnostics,
});

const services: ResolutionServicesType = {
	resolveSimpleAt: (): ResolutionType => ({symbolId: null, outcome: 'no-declaration'}),
	resolveMember: (): string | null => null,
	resolveSite: (): ResolutionType => ({symbolId: null, outcome: 'no-declaration'}),
	syntheticSite: (_declaration, _index) => siteOf(),
};

const choose = (
	candidates: readonly ChoiceCandidateType[],
	site: OracleReferenceSiteType,
	state = stateOf(),
	reportAmbiguity = true,
): ReturnType<typeof chooseCandidateOf> => chooseCandidateOf(services, {candidates, site}, state, reportAmbiguity);

describe('Oracle candidate deduplication', () => {
	it('returns no declaration for an empty candidate set', () => {
		expect(choose([], siteOf())).toStrictEqual({choice: null, outcome: 'no-declaration'});
	});

	it('rejects empty identifiers, deduplicates, and resolves a single candidate', () => {
		const candidate = candidateOf('symbol', 'variable', 'ITEM');

		expect(choose([candidateOf('', 'variable', 'EMPTY')], siteOf())).toStrictEqual({choice: null, outcome: 'no-declaration'});
		expect(choose([candidate, candidateOf('symbol', 'variable', 'ITEM')], siteOf())).toStrictEqual({choice: candidate, outcome: 'resolved'});
	});
});

describe('Oracle call candidate selection', () => {
	it('resolves one candidate by arity', () => {
		const candidate = candidateOf('one', 'procedure', 'RUN', {parameters: [parameterOf('P_A')]});

		expect(choose([candidate], siteOf({kind: 'call', argumentCount: 1}))).toStrictEqual({choice: candidate, outcome: 'resolved'});
	});

	it('reports an ambiguous overload with and without trace diagnostics', () => {
		const candidates = [
			candidateOf('a', 'procedure', 'RUN', {parameters: [parameterOf('P_A')]}),
			candidateOf('b', 'procedure', 'RUN', {parameters: [parameterOf('P_B')]}),
		];
		const reporting = stateOf();

		expect(choose(candidates, siteOf({kind: 'call', argumentCount: 1}), reporting, true)).toStrictEqual({choice: null, outcome: 'ambiguous-overload'});
		expect(reporting.diagnostics.finish().map((diagnostic) => diagnostic.message)).toContain('Ambiguous overload for run');
		expect(choose(candidates, siteOf({kind: 'call', argumentCount: 1}), stateOf(), false)).toStrictEqual({choice: null, outcome: 'ambiguous-overload'});
	});

	it('falls back to a non-routine for collection indexing and then to no declaration', () => {
		const collection = candidateOf('collection', 'collection_type', 'ITEMS', {type: 'NUMBER'});
		const routine = candidateOf('routine', 'procedure', 'RUN', {parameters: [parameterOf('P_A'), parameterOf('P_B')]});

		const otherRoutine = candidateOf('other-routine', 'procedure', 'RUN', {parameters: [parameterOf('P_A'), parameterOf('P_B')]});

		expect(choose([collection, routine], siteOf({kind: 'call', argumentCount: 1}))).toStrictEqual({choice: collection, outcome: 'resolved'});
		expect(choose([routine, otherRoutine], siteOf({kind: 'call', argumentCount: 1}))).toStrictEqual({choice: null, outcome: 'no-declaration'});
	});

	it('uses a statement-position call to choose a procedure over a function', () => {
		const procedure = candidateOf('p', 'procedure', 'RUN', {parameters: [parameterOf('P_A')]});
		const fn = candidateOf('f', 'function', 'RUN', {parameters: [parameterOf('P_A')]});

		expect(choose([procedure, fn], siteOf({kind: 'call', argumentCount: 1, statementCall: true}))).toStrictEqual({choice: procedure, outcome: 'resolved'});
		expect(choose([procedure, fn], siteOf({kind: 'call', argumentCount: 1, statementCall: false}))).toStrictEqual({choice: fn, outcome: 'resolved'});
	});
});

describe('Oracle non-call candidate selection', () => {
	it('returns the single non-routine candidate', () => {
		const candidate = candidateOf('v', 'variable', 'ITEM');

		expect(choose([candidate], siteOf())).toStrictEqual({choice: candidate, outcome: 'resolved'});
	});

	it('selects the nearest same-file declaration before a later one', () => {
		const earlier = candidateOf('early', 'variable', 'ITEM', {offset: 1});
		const later = candidateOf('late', 'variable', 'ITEM', {offset: 50});

		expect(choose([later, earlier], siteOf({offset: 10}))).toStrictEqual({choice: earlier, outcome: 'resolved'});
	});

	it('sorts candidates across files when no same-file declaration precedes the site', () => {
		const zeta = candidateOf('z', 'variable', 'ITEM', {path: 'z.pkb', offset: 1});
		const alpha = candidateOf('a', 'variable', 'ITEM', {path: 'a.pkb', offset: 50});

		expect(choose([zeta, alpha], siteOf({offset: 0}))).toStrictEqual({choice: alpha, outcome: 'resolved'});
	});

	it('uses arity for routine references and preserves type-anchor ambiguity', () => {
		const one = candidateOf('one', 'procedure', 'RUN', {parameters: [parameterOf('P_A')]});
		const two = candidateOf('two', 'procedure', 'RUN', {parameters: [parameterOf('P_A'), parameterOf('P_B')]});

		expect(choose([one, two], siteOf({argumentCount: 1}))).toStrictEqual({choice: one, outcome: 'resolved'});
		expect(choose([one, two], siteOf({argumentCount: 0}))).toStrictEqual({choice: null, outcome: 'no-declaration'});
		expect(choose([one, two], siteOf({argumentCount: 1}), stateOf(), false)).toStrictEqual({choice: one, outcome: 'resolved'});
		const alternate = candidateOf('alternate', 'procedure', 'RUN', {parameters: [parameterOf('P_A')]});

		expect(choose([one, alternate], siteOf({kind: 'type-anchor'}))).toStrictEqual({choice: null, outcome: 'ambiguous-overload'});
	});

	it('prefers exact argument types and then the compatible family', () => {
		const number = candidateOf('n', 'procedure', 'RUN', {parameters: [parameterOf('P_A', {type: 'NUMBER'})]});
		const text = candidateOf('t', 'procedure', 'RUN', {parameters: [parameterOf('P_A', {type: 'VARCHAR2'})]});
		const argument = {
			range: range(),
			name: null,
			leadName: nameOf('L_TEXT'),
			indexed: false,
			literalType: 'VARCHAR2',
		};
		const typedServices: ResolutionServicesType = {
			...services,
			resolveSite: (): ResolutionType => ({symbolId: 'argument', outcome: 'resolved'}),
		};

		expect(chooseCandidateOf(typedServices, {candidates: [number, text], site: siteOf({kind: 'call', arguments: [argument]})}, stateOf(), false)).toStrictEqual(
			{
				choice: text,
				outcome: 'resolved',
			},
		);
	});

	it('skips OUT and anchored parameters and keeps candidates when types are unknown', () => {
		const out = candidateOf('out', 'procedure', 'RUN', {parameters: [parameterOf('P_A', {mode: 'OUT', type: 'NUMBER'})]});
		const anchored = candidateOf('anchor', 'procedure', 'RUN', {parameters: [parameterOf('P_A', {type: 'VARCHAR2', anchored: true})]});
		const argument = {range: range(), name: null, leadName: nameOf('L_VALUE'), indexed: false};
		const unknownServices: ResolutionServicesType = {...services, resolveSite: () => ({symbolId: null, outcome: 'no-declaration'})};

		expect(
			chooseCandidateOf(unknownServices, {candidates: [out, anchored], site: siteOf({kind: 'call', arguments: [argument]})}, stateOf(), false),
		).toStrictEqual({
			choice: null,
			outcome: 'ambiguous-overload',
		});
	});
});
