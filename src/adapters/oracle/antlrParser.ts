import {BaseErrorListener, CharStream, CommonTokenStream} from 'antlr4ng';
import {type DiagnosticType} from '../../core/model.ts';
import {collectAntlrDeclarations} from './antlrDeclarations.ts';
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
	errorCount: number;
}>;

const boundedMessage = (error: unknown): string => {
	const message = error instanceof Error ? error.message : String(error);

	return message.replaceAll(process.cwd(), '<workspace>');
};

const parseOnce = (source: string, input: OracleParseInputType, collector: OracleDiagnosticCollector): ParsedUnitsType => {
	let errorCount = 0;

	try {
		const lexer = new PlSqlLexer(CharStream.fromString(source));
		lexer.removeErrorListeners();

		const stream = new CommonTokenStream(lexer);
		const parser = new PlSqlParser(stream);
		parser.removeErrorListeners();
		parser.addErrorListener(
			new OracleAntlrErrorListener((line, column, message) => {
				errorCount += 1;
				collector.add(ORACLE_DIAGNOSTIC.parse, message, line, column);
			}),
		);

		const script = parser.sql_script();
		const collected = collectAntlrDeclarations({...input, source}, script);

		return {...collected, errorCount};
	} catch (error: unknown) {
		collector.add(ORACLE_DIAGNOSTIC.parse, `ANTLR parser failure: ${boundedMessage(error)}`);

		return {units: [], declarations: [], errorCount: errorCount + 1};
	}
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
	collector: OracleDiagnosticCollector,
): Readonly<{units: readonly OracleUnitType[]; declarations: readonly OracleDeclarationType[]}> => {
	const units: OracleUnitType[] = [];
	const declarations: OracleDeclarationType[] = [];

	for (const segment of solidusSegments(source, tokens)) {
		const masked = `${blank(source.slice(0, segment.start))}${source.slice(segment.start, segment.end)}${blank(source.slice(segment.end))}`;
		const parsed = parseOnce(masked, input, collector);

		units.push(...parsed.units);
		declarations.push(...parsed.declarations);
	}

	return {units, declarations};
};

/**
 * Parses one Oracle source file with the pinned ANTLR parser.
 *
 * Conditional-compilation directives and literal-disabled branches are removed
 * before parsing while preserving source offsets. ANTLR lexer, parser, token
 * stream, and parse tree stay inside this call; only serializable facts leave.
 *
 * Phase 3 emits package and routine units plus their declarations, including
 * parameters, types, fields, and nested routines. References and dependencies
 * remain empty until the Phase 4–5 visitors land.
 *
 * @param input - Source text, workspace-relative path, and default schema.
 * @returns Serializable parse facts and bounded diagnostics.
 */
export const parseWithAntlr = (input: OracleParseInputType): OracleParseResultType => {
	const rawTokenized = tokenizeOracleSource(input.source, input.path);
	const conditional = prepareConditionalSource({source: input.source, path: input.path, tokens: rawTokenized.tokens});
	const filtered = conditional.source === input.source ? rawTokenized : tokenizeOracleSource(conditional.source, input.path);
	const probeCollector = new OracleDiagnosticCollector(input.path);
	const probe = parseOnce(conditional.source, input, probeCollector);
	let parsed: Readonly<{units: readonly OracleUnitType[]; declarations: readonly OracleDeclarationType[]}> = probe;
	let parseDiagnostics = probeCollector.finish();

	if (probe.errorCount > 0) {
		// A malformed unit can consume the rest of the file under ANTLR's default
		// recovery. Reparse each SQL*Plus solidus-delimited segment in isolation so
		// later units survive without falling back to the structural parser.
		const recoveryCollector = new OracleDiagnosticCollector(input.path);
		parsed = recoverSegments(input, conditional.source, filtered.tokens, recoveryCollector);
		parseDiagnostics = recoveryCollector.finish();
	}

	const diagnostics: readonly DiagnosticType[] = [...filtered.diagnostics, ...conditional.diagnostics, ...parseDiagnostics];

	return {
		units: parsed.units,
		declarations: parsed.declarations,
		references: [],
		dependencies: [],
		diagnostics,
	};
};

/**
 * Production parser seam; Phase 8 binds this to the structural parser.
 *
 * @param input - Source text, workspace-relative path, and default schema.
 * @returns Serializable parse facts and bounded diagnostics.
 */
export const antlrOracleParser: OracleParserType = (input) => parseWithAntlr(input);
