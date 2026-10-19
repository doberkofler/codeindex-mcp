import {type DiagnosticType} from '../../core/model.ts';
import {ORACLE_DIAGNOSTIC, OracleDiagnosticCollector} from './diagnostics.ts';
import {type OracleTokenType} from './tokenize.ts';

const CONDITIONAL_DIRECTIVES = new Set(['$IF', '$THEN', '$ELSIF', '$ELSE', '$END', '$ERROR']);

type ConditionalFrameType = {
	parentDisabled: boolean;
	disabled: boolean;
	satisfied: boolean;
	branchStart: number | null;
	token: OracleTokenType;
};

type BlankRangeType = Readonly<{start: number; end: number}>;

type ConditionalResultType = Readonly<{
	/** Source with directives and literal-disabled branches blanked in place. */
	source: string;
	diagnostics: readonly DiagnosticType[];
}>;

const directiveOf = (token: OracleTokenType): string | null => {
	const directive = token.text.toUpperCase();

	return token.channel === 'visible' && CONDITIONAL_DIRECTIVES.has(directive) ? directive : null;
};

const nextDirectiveIndex = (tokens: readonly OracleTokenType[], expressionStart: number): number | null => {
	for (let index = expressionStart; index < tokens.length; index += 1) {
		const token = tokens[index];

		if (token !== undefined && directiveOf(token) !== null) {
			return index;
		}
	}

	return null;
};

/**
 * Reads a literal boolean `$IF` or `$ELSIF` condition.
 *
 * Unknown expressions return `null` and keep both branches. The adapter does
 * not evaluate session values or compilation parameters.
 *
 * @param tokens - Full token stream, including hidden tokens.
 * @param ifIndex - Index of the `$IF` or `$ELSIF` token.
 * @returns The literal condition, the end of its directive clause, and the `$THEN` index.
 */
const literalCondition = (
	tokens: readonly OracleTokenType[],
	ifIndex: number,
): Readonly<{value: boolean | null; clauseEnd: number; thenIndex: number | null}> => {
	const parts: string[] = [];
	let lastToken: OracleTokenType | undefined = tokens[ifIndex];

	for (let index = ifIndex + 1; index < tokens.length; index += 1) {
		const token = tokens[index];

		if (token === undefined) {
			break;
		}

		if (token.channel !== 'visible') {
			continue;
		}

		lastToken = token;

		const upper = token.text.toUpperCase();

		if (upper === '$THEN') {
			const condition = parts.join('').replaceAll(/\s/gu, '');
			const value = condition === 'TRUE' ? true : condition === 'FALSE' ? false : null;

			return {value, clauseEnd: token.endOffset, thenIndex: index};
		}

		if (CONDITIONAL_DIRECTIVES.has(upper)) {
			break;
		}

		parts.push(upper);
	}

	const condition = parts.join('').replaceAll(/\s/gu, '');
	const value = condition === 'TRUE' ? true : condition === 'FALSE' ? false : null;

	return {value, clauseEnd: lastToken?.endOffset ?? tokens[ifIndex]?.endOffset ?? 0, thenIndex: null};
};

const addRange = (ranges: BlankRangeType[], start: number, end: number): void => {
	if (end > start) {
		ranges.push({start, end});
	}
};

const closeBranch = (ranges: BlankRangeType[], frame: ConditionalFrameType, end: number): void => {
	if (frame.branchStart !== null) {
		if (frame.disabled) {
			addRange(ranges, frame.branchStart, end);
		}

		frame.branchStart = null;
	}
};

const blankPreservingLines = (text: string): string => text.replaceAll(/[^\r\n]/gu, ' ');

const mergeRanges = (ranges: readonly BlankRangeType[]): readonly BlankRangeType[] => {
	const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: {start: number; end: number}[] = [];

	for (const range of sorted) {
		const previous = merged.at(-1);

		if (previous !== undefined && range.start <= previous.end) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({...range});
		}
	}

	return merged;
};

const applyRanges = (source: string, ranges: readonly BlankRangeType[]): string => {
	const merged = mergeRanges(ranges);
	const chunks: string[] = [];
	let cursor = 0;

	for (const range of merged) {
		chunks.push(source.slice(cursor, range.start), blankPreservingLines(source.slice(range.start, range.end)));
		cursor = range.end;
	}

	chunks.push(source.slice(cursor));

	return chunks.join('');
};

type ConditionalStateType = {
	collector: OracleDiagnosticCollector;
	ranges: BlankRangeType[];
	stack: ConditionalFrameType[];
};

const report = (state: ConditionalStateType, message: string, token: OracleTokenType | undefined): void => {
	state.collector.add(ORACLE_DIAGNOSTIC.conditionalCompilation, message, token?.startLine ?? null, token?.startColumn ?? null);
};

const handleConditionStart = (
	state: ConditionalStateType,
	tokens: readonly OracleTokenType[],
	start: Readonly<{index: number; directive: '$IF' | '$ELSIF'; token: OracleTokenType}>,
): number => {
	const {directive, index, token} = start;
	const frame = state.stack.at(-1);
	const condition = literalCondition(tokens, index);
	const {ranges} = state;

	if (directive === '$IF') {
		addRange(ranges, token.startOffset, condition.clauseEnd);
		state.stack.push({
			parentDisabled: frame?.disabled ?? false,
			disabled: (frame?.disabled ?? false) || condition.value === false,
			satisfied: condition.value === true,
			branchStart: condition.clauseEnd,
			token,
		});
	} else if (frame === undefined) {
		addRange(ranges, token.startOffset, condition.clauseEnd);
		report(state, '$ELSIF without a matching $IF', token);
	} else {
		closeBranch(ranges, frame, token.startOffset);
		addRange(ranges, token.startOffset, condition.clauseEnd);
		frame.disabled = frame.parentDisabled || frame.satisfied || condition.value === false;
		frame.satisfied ||= condition.value === true;
		frame.branchStart = condition.clauseEnd;
	}

	if (condition.thenIndex === null) {
		report(state, `Unterminated ${directive} condition: missing $THEN`, token);
	}

	return condition.thenIndex !== null ? condition.thenIndex + 1 : (nextDirectiveIndex(tokens, index + 1) ?? tokens.length);
};

const handleConditionalBranch = (state: ConditionalStateType, directive: string, token: OracleTokenType): void => {
	const {ranges} = state;
	const frame = state.stack.at(-1);

	if (directive === '$ELSE') {
		addRange(ranges, token.startOffset, token.endOffset);

		if (frame === undefined) {
			report(state, '$ELSE without a matching $IF', token);
			return;
		}

		closeBranch(ranges, frame, token.startOffset);
		frame.disabled = frame.parentDisabled || frame.satisfied;
		frame.satisfied = true;
		frame.branchStart = token.endOffset;
		return;
	}

	if (directive === '$END') {
		const closed = state.stack.pop();
		addRange(ranges, token.startOffset, token.endOffset);

		if (closed === undefined) {
			report(state, '$END without a matching $IF', token);
		} else {
			closeBranch(ranges, closed, token.startOffset);
		}
		return;
	}

	addRange(ranges, token.startOffset, token.endOffset);

	if (directive === '$THEN') {
		report(state, '$THEN without a matching $IF', token);
	} else {
		report(state, '$ERROR directive is not supported by the Oracle extractor', token);
	}
};

/**
 * Removes conditional-compilation directives and literal-disabled branches
 * before parsing while preserving every source offset.
 *
 * Literal `$IF TRUE` and `$IF FALSE` branches are evaluated. Non-literal
 * conditions keep both branches because the adapter cannot evaluate session
 * values. Unbalanced directives and branch content that is blanked emit
 * bounded diagnostics instead of truncating the file.
 *
 * @param input - Source text, workspace-relative path, and its token stream.
 * @returns Parsable source with the same length and bounded diagnostics.
 */
export const prepareConditionalSource = (input: Readonly<{source: string; path: string; tokens: readonly OracleTokenType[]}>): ConditionalResultType => {
	const state: ConditionalStateType = {
		collector: new OracleDiagnosticCollector(input.path),
		ranges: [],
		stack: [],
	};

	let index = 0;

	while (index < input.tokens.length) {
		const token = input.tokens[index];
		const directive = token === undefined ? null : directiveOf(token);

		if (token === undefined || directive === null) {
			index += 1;
			continue;
		}

		if (directive === '$IF' || directive === '$ELSIF') {
			index = handleConditionStart(state, input.tokens, {index, directive, token});
			continue;
		}

		handleConditionalBranch(state, directive, token);
		index += 1;
	}

	for (const frame of state.stack) {
		closeBranch(state.ranges, frame, input.source.length);
	}

	const [first] = state.stack;

	if (first !== undefined) {
		report(state, `Unterminated $IF: ${String(state.stack.length)} conditional block(s) remain open`, first.token);
	}

	return {source: applyRanges(input.source, state.ranges), diagnostics: state.collector.finish()};
};
