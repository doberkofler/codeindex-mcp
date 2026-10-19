import {type Token} from 'antlr4ng';
import {
	ParameterContext,
	PlSqlParser,
	TerminatorContext,
	type Column_nameContext,
	type Function_nameContext,
	type IdentifierContext,
	type Parameter_specContext,
	type Procedure_nameContext,
	type Script_unitContext,
} from './generated/PlSqlParser.ts';
import {namePartOf, type OracleNamePartType} from './name.ts';
import {endPositionOf} from './sourceLocation.ts';
import {type OracleParameterType, type OracleParseInputType, type OracleRangeType} from './syntax.ts';

export type OracleNameInfoType = Readonly<{name: OracleNamePartType; token: Token | null}>;

export const rangeOf = (input: OracleParseInputType, start: Token | null, stop: Token | null): OracleRangeType => {
	const startOffset = Math.max(0, start?.start ?? 0);
	const endOffset = Math.max(startOffset, (stop?.stop ?? startOffset - 1) + 1);
	const startLine = start?.line ?? 1;
	const startColumn = (start?.column ?? 0) + 1;
	const end = endPositionOf(input.source.slice(startOffset, endOffset), startLine, startColumn);

	return {startOffset, endOffset, startLine, startColumn, endLine: end.line, endColumn: end.column};
};

const nameInfoOfIdExpression = (idExpression: Readonly<{getText: () => string; start: Token | null}>): OracleNameInfoType => ({
	name: namePartOf(idExpression.getText()),
	token: idExpression.start,
});

export const nameInfoOfIdentifier = (identifier: IdentifierContext): OracleNameInfoType => nameInfoOfIdExpression(identifier.id_expression());

export const nameInfoOfColumn = (column: Column_nameContext): OracleNameInfoType =>
	nameInfoOfIdExpression(column.id_expression().at(-1) ?? column.identifier().id_expression());

export const nameInfoOfRoutineName = (name: Function_nameContext | Procedure_nameContext): OracleNameInfoType =>
	nameInfoOfIdExpression(name.id_expression() ?? name.identifier().id_expression());

export const nameRangeOf = (input: OracleParseInputType, info: OracleNameInfoType): OracleRangeType => rangeOf(input, info.token, info.token);

const parameterOf = (input: OracleParseInputType, context: ParameterContext | Parameter_specContext): OracleParameterType => {
	const name = context.parameter_name().identifier().id_expression();
	const inputToken = context instanceof ParameterContext ? context.getToken(PlSqlParser.IN, 0) : null;
	const outputToken = context instanceof ParameterContext ? context.getToken(PlSqlParser.OUT, 0) : null;
	const mode =
		inputToken !== null && outputToken !== null && inputToken.symbol.tokenIndex < outputToken.symbol.tokenIndex
			? 'IN OUT'
			: outputToken === null
				? 'IN'
				: 'OUT';

	return {
		name: namePartOf(name.getText()),
		nameRange: rangeOf(input, name.start, name.stop),
		range: rangeOf(input, context.start, context.stop),
		mode,
		hasDefault: context.default_value_part() !== null,
		typeText: context.type_spec()?.getText().toUpperCase() ?? '',
		typeReferences: [],
	};
};

export const parametersOf = (input: OracleParseInputType, parameters: readonly ParameterContext[]): readonly OracleParameterType[] =>
	parameters.map((parameter) => parameterOf(input, parameter));

export const parameterSpecsOf = (input: OracleParseInputType, parameters: readonly Parameter_specContext[]): readonly OracleParameterType[] =>
	parameters.map((parameter) => parameterOf(input, parameter));

const terminatorAfter = (scriptUnit: Script_unitContext): TerminatorContext | null => {
	const {parent} = scriptUnit;

	if (parent === null) {
		return null;
	}

	for (let index = 0; index < parent.getChildCount(); index += 1) {
		if (parent.getChild(index) !== scriptUnit) {
			continue;
		}

		const sibling = parent.getChild(index + 1);

		return sibling instanceof TerminatorContext ? sibling : null;
	}

	return null;
};

export const topLevelStop = (scriptUnit: Script_unitContext, context: Readonly<{stop: Token | null}>): Token | null =>
	terminatorAfter(scriptUnit)?.getToken(PlSqlParser.SEMICOLON, 0)?.symbol ?? context.stop;
