import {BailErrorStrategy, BaseErrorListener, CharStream, CommonTokenStream, PredictionMode} from 'antlr4ng';
import {type DiagnosticType} from '../../core/model.ts';
import {collectAntlrDeclarations} from './antlrDeclarations.ts';
import {collectAntlrDependencies} from './antlrDependencies.ts';
import {collectAntlrReferences} from './antlrReferences.ts';
import {collectAntlrSqlNames} from './antlrSqlNames.ts';
import {prepareConditionalSource} from './conditionalCompilation.ts';
import {ORACLE_DIAGNOSTIC, OracleDiagnosticCollector} from './diagnostics.ts';
import {PlSqlParser} from './generated/PlSqlParser.ts';
import {PlSqlLexer} from './generated/PlSqlLexer.ts';
import {type OracleDeclarationType, type OracleParseInputType, type OracleParseResultType, type OracleParserType, type OracleUnitType} from './syntax.ts';
import {tokenizeOracleSource, type OracleTokenType} from './tokenize.ts';

class OracleAntlrErrorListener extends BaseErrorListener {
	readonly #report: (line: number, column: number, message: string) => void;

	public constructor(report: (line: number, column: number, message: string) => void) {
		super();
		this.#report = report;
	}

	public override syntaxError(...args: Parameters<BaseErrorListener['syntaxError']>): void {
		const {2: line, 3: column, 4: message} = args;
		this.#report(line, column + 1, message);
	}
}

type ParsedUnitsType = Readonly<{
	units: readonly OracleUnitType[];
	declarations: readonly OracleDeclarationType[];
	references: OracleParseResultType['references'];
	dependencies: OracleParseResultType['dependencies'];
	errorCount: number;
}>;

/** Measured phases for one file. Timings are wall-clock milliseconds. */
export type OracleAntlrProfileType = Readonly<{
	tokenizeMs: number;
	conditionalMs: number;
	retokenizeMs: number;
	lexerMs: number;
	sllParseMs: number;
	llParseMs: number;
	declarationsMs: number;
	referencesMs: number;
	sqlNamesMs: number;
	dependenciesMs: number;
	recoveryMs: number;
	totalMs: number;
	prediction: 'sll' | 'sll-fallback-ll';
	recovered: boolean;
	sllAttempts: number;
	llAttempts: number;
}>;

export type OracleAntlrProfiledResultType = Readonly<{
	result: OracleParseResultType;
	profile: OracleAntlrProfileType;
}>;

type ProfilePhaseType = Exclude<keyof OracleAntlrProfileType, 'totalMs' | 'prediction' | 'recovered' | 'sllAttempts' | 'llAttempts'>;

type ProfileDraftType = Record<ProfilePhaseType, number> & {
	startedAt: number;
	recovered: boolean;
	sllAttempts: number;
	llAttempts: number;
};

const createProfileDraft = (): ProfileDraftType => ({
	startedAt: performance.now(),
	tokenizeMs: 0,
	conditionalMs: 0,
	retokenizeMs: 0,
	lexerMs: 0,
	sllParseMs: 0,
	llParseMs: 0,
	declarationsMs: 0,
	referencesMs: 0,
	sqlNamesMs: 0,
	dependenciesMs: 0,
	recoveryMs: 0,
	recovered: false,
	sllAttempts: 0,
	llAttempts: 0,
});

const timed = <ValueType>(profile: ProfileDraftType | undefined, phase: ProfilePhaseType, action: () => ValueType): ValueType => {
	if (profile === undefined) {
		return action();
	}

	const startedAt = performance.now();

	try {
		return action();
	} finally {
		profile[phase] += performance.now() - startedAt;
	}
};

const finishProfile = (profile: ProfileDraftType): OracleAntlrProfileType => ({
	tokenizeMs: profile.tokenizeMs,
	conditionalMs: profile.conditionalMs,
	retokenizeMs: profile.retokenizeMs,
	lexerMs: profile.lexerMs,
	sllParseMs: profile.sllParseMs,
	llParseMs: profile.llParseMs,
	declarationsMs: profile.declarationsMs,
	referencesMs: profile.referencesMs,
	sqlNamesMs: profile.sqlNamesMs,
	dependenciesMs: profile.dependenciesMs,
	recoveryMs: profile.recoveryMs,
	totalMs: performance.now() - profile.startedAt,
	prediction: profile.llAttempts > 0 ? 'sll-fallback-ll' : 'sll',
	recovered: profile.recovered,
	sllAttempts: profile.sllAttempts,
	llAttempts: profile.llAttempts,
});

const boundedMessage = (error: unknown): string => {
	const message = error instanceof Error ? error.message : String(error);

	return message.replaceAll(process.cwd(), '<workspace>');
};

type ParseAttemptOptionsType = Readonly<{
	source: string;
	prediction: 'sll' | 'll';
	collector?: OracleDiagnosticCollector | undefined;
	profile?: ProfileDraftType | undefined;
}>;

const parseAttempt = (
	input: OracleParseInputType,
	options: ParseAttemptOptionsType,
): Readonly<{parsed: ParsedUnitsType; diagnostics: readonly DiagnosticType[]}> => {
	const {collector: sharedCollector, prediction, profile, source} = options;
	const collector = sharedCollector ?? new OracleDiagnosticCollector(input.path);
	let errorCount = 0;

	if (profile !== undefined) {
		if (prediction === 'sll') {
			profile.sllAttempts += 1;
		} else {
			profile.llAttempts += 1;
		}
	}

	try {
		const lexer = new PlSqlLexer(CharStream.fromString(source));
		lexer.removeErrorListeners();

		const stream = new CommonTokenStream(lexer);
		timed(profile, 'lexerMs', () => {
			stream.fill();
		});

		const parser = new PlSqlParser(stream);
		parser.removeErrorListeners();
		parser.addErrorListener(
			new OracleAntlrErrorListener((line, column, message) => {
				errorCount += 1;
				collector.add(ORACLE_DIAGNOSTIC.parse, message, line, column);
			}),
		);
		parser.interpreter.predictionMode = prediction === 'sll' ? PredictionMode.SLL : PredictionMode.LL;

		if (prediction === 'sll') {
			// The SLL pass is a probe: abort at the first syntax error instead of
			// spending recovery work on a tree that will be reparsed with LL.
			parser.errorHandler = new BailErrorStrategy();
		}

		const script = timed(profile, prediction === 'sll' ? 'sllParseMs' : 'llParseMs', () => parser.sql_script());

		// A failed SLL pass is discarded and reparsed with LL. Its tree may have
		// recovered into a shape the visitors do not accept, so never visit it.
		if (prediction === 'sll' && errorCount > 0) {
			return {parsed: {units: [], declarations: [], references: [], dependencies: [], errorCount}, diagnostics: collector.finish()};
		}

		const collected = timed(profile, 'declarationsMs', () => collectAntlrDeclarations({...input, source}, script));
		const references = timed(profile, 'referencesMs', () => collectAntlrReferences({...input, source}, script, collected.declarations));
		const sqlNames = timed(profile, 'sqlNamesMs', () => collectAntlrSqlNames(script));
		const dependencies = timed(profile, 'dependenciesMs', () => collectAntlrDependencies({references, declarations: collected.declarations, sqlNames}));

		return {parsed: {...collected, references, dependencies, errorCount}, diagnostics: collector.finish()};
	} catch (error: unknown) {
		// A bailed SLL probe is expected; the LL retry owns the real diagnostics.
		if (prediction === 'sll') {
			return {
				parsed: {units: [], declarations: [], references: [], dependencies: [], errorCount: Math.max(1, errorCount)},
				diagnostics: collector.finish(),
			};
		}

		collector.add(ORACLE_DIAGNOSTIC.parse, `ANTLR parser failure: ${boundedMessage(error)}`);

		return {
			parsed: {units: [], declarations: [], references: [], dependencies: [], errorCount: errorCount + 1},
			diagnostics: collector.finish(),
		};
	}
};

const parseOnce = (
	source: string,
	input: OracleParseInputType,
	collector?: OracleDiagnosticCollector,
	profile?: ProfileDraftType,
): Readonly<{parsed: ParsedUnitsType; diagnostics: readonly DiagnosticType[]}> => {
	// SLL resolves the common case without full-context prediction. LL is the
	// fallback only when SLL reports a syntax error, never a silent merge.
	const sll = parseAttempt(input, {profile, prediction: 'sll', source});

	if (sll.parsed.errorCount === 0) {
		return sll;
	}

	return parseAttempt(input, {collector, profile, prediction: 'll', source});
};

const blank = (text: string): string => text.replaceAll(/[^\r\n]/gu, ' ');

const solidusSegments = (source: string, tokens: readonly OracleTokenType[]): readonly Readonly<{start: number; end: number}>[] => {
	const visible = tokens.filter((token) => token.channel === 'visible');
	const segments: {start: number; end: number}[] = [];
	let start = 0;

	for (const [index, token] of visible.entries()) {
		if (token.text !== '/') {
			continue;
		}

		const previous = visible[index - 1];
		const next = visible[index + 1];
		const isSeparator = (previous === undefined || previous.startLine !== token.startLine) && (next === undefined || next.startLine !== token.startLine);

		if (isSeparator) {
			segments.push({start, end: token.endOffset});
			start = token.endOffset;
		}
	}

	segments.push({start, end: source.length});

	return segments.filter((segment) => source.slice(segment.start, segment.end).trim().length > 0);
};

const recoverSegments = (
	input: OracleParseInputType,
	source: string,
	tokens: readonly OracleTokenType[],
	options: Readonly<{collector: OracleDiagnosticCollector; profile?: ProfileDraftType | undefined}>,
): Pick<OracleParseResultType, 'units' | 'declarations' | 'references' | 'dependencies'> => {
	const {collector, profile} = options;
	const units: OracleUnitType[] = [];
	const declarations: OracleDeclarationType[] = [];
	const references: OracleParseResultType['references'][number][] = [];
	const dependencies: OracleParseResultType['dependencies'][number][] = [];

	for (const segment of solidusSegments(source, tokens)) {
		const masked = `${blank(source.slice(0, segment.start))}${source.slice(segment.start, segment.end)}${blank(source.slice(segment.end))}`;
		const {parsed} = parseOnce(masked, input, collector, profile);
		const declarationOffset = declarations.length;
		const unitOffset = units.length;

		units.push(...parsed.units.map((unit) => ({...unit, declaration: unit.declaration + declarationOffset})));
		declarations.push(
			...parsed.declarations.map((declaration) => ({
				...declaration,
				parent: declaration.parent === null ? null : declaration.parent + declarationOffset,
				unit: declaration.unit + unitOffset,
			})),
		);
		references.push(
			...parsed.references.map((reference) => ({
				...reference,
				enclosing: reference.enclosing + declarationOffset,
				unit: reference.unit + unitOffset,
			})),
		);
		dependencies.push(
			...parsed.dependencies.map((dependency) => ({
				...dependency,
				enclosing: dependency.enclosing + declarationOffset,
				unit: dependency.unit + unitOffset,
			})),
		);
	}

	return {units, declarations, references, dependencies};
};

/**
 * Parses one Oracle source file with the pinned ANTLR parser.
 *
 * Conditional-compilation directives and literal-disabled branches are removed
 * before parsing while preserving source offsets. ANTLR lexer, parser, token
 * stream, and parse tree stay inside this call; only serializable facts leave.
 *
 * Emits package and routine units, declarations, reference sites, and package
 * dependency sites. Recovery reparses solidus-delimited segments and offsets
 * declaration, unit, reference, and dependency indexes before returning.
 *
 * @param input - Source text, workspace-relative path, and default schema.
 * @param profile - Optional mutable accumulator for phase timings.
 * @returns Serializable parse facts and bounded diagnostics.
 */
const parseInternal = (input: OracleParseInputType, profile?: ProfileDraftType): OracleParseResultType => {
	const rawTokenized = timed(profile, 'tokenizeMs', () => tokenizeOracleSource(input.source, input.path));
	const conditional = timed(profile, 'conditionalMs', () => prepareConditionalSource({source: input.source, path: input.path, tokens: rawTokenized.tokens}));
	const filtered =
		conditional.source === input.source ? rawTokenized : timed(profile, 'retokenizeMs', () => tokenizeOracleSource(conditional.source, input.path));
	const probe = parseOnce(conditional.source, input, undefined, profile);
	let parsed: Pick<OracleParseResultType, 'units' | 'declarations' | 'references' | 'dependencies'> = probe.parsed;
	let parseDiagnostics = probe.diagnostics;

	if (probe.parsed.errorCount > 0) {
		// A malformed unit can consume the rest of the file under ANTLR's default
		// recovery. Reparse each SQL*Plus solidus-delimited segment in isolation so
		// later units survive without falling back to the structural parser.
		if (profile !== undefined) {
			profile.recovered = true;
		}

		const recoveryCollector = new OracleDiagnosticCollector(input.path);
		parsed = timed(profile, 'recoveryMs', () => recoverSegments(input, conditional.source, filtered.tokens, {collector: recoveryCollector, profile}));
		parseDiagnostics = recoveryCollector.finish();
	}

	const diagnostics: readonly DiagnosticType[] = [...filtered.diagnostics, ...conditional.diagnostics, ...parseDiagnostics];

	return {
		units: parsed.units,
		declarations: parsed.declarations,
		references: parsed.references,
		dependencies: parsed.dependencies,
		diagnostics,
	};
};

/**
 * Parses one file and returns the same facts plus per-phase wall-clock timings.
 *
 * Profiling is opt-in so normal parsing pays no timing or bookkeeping cost.
 * The profile is intended for standalone performance evidence, not persisted
 * generation facts.
 *
 * @param input - Source text, workspace-relative path, and default schema.
 * @returns Serializable parse facts and measured phases.
 */
export const parseWithAntlrProfiled = (input: OracleParseInputType): OracleAntlrProfiledResultType => {
	const profile = createProfileDraft();

	return {result: parseInternal(input, profile), profile: finishProfile(profile)};
};

/**
 * Parses one Oracle source file with the pinned ANTLR parser.
 *
 * Conditional-compilation directives and literal-disabled branches are removed
 * before parsing while preserving source offsets. ANTLR lexer, parser, token
 * stream, and parse tree stay inside this call; only serializable facts leave.
 *
 * Emits package and routine units, declarations, reference sites, and package
 * dependency sites. Recovery reparses solidus-delimited segments and offsets
 * declaration, unit, reference, and dependency indexes before returning.
 *
 * @param input - Source text, workspace-relative path, and default schema.
 * @returns Serializable parse facts and bounded diagnostics.
 */
export const parseWithAntlr = (input: OracleParseInputType): OracleParseResultType => parseInternal(input);

/**
 * Production parser seam; Phase 8 binds this to the structural parser.
 *
 * @param input - Source text, workspace-relative path, and default schema.
 * @returns Serializable parse facts and bounded diagnostics.
 */
export const antlrOracleParser: OracleParserType = (input) => parseWithAntlr(input);
