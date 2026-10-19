import {ParserRuleContext} from 'antlr4ng';
import {BlockContext, Function_bodyContext, Loop_statementContext, Procedure_bodyContext, type Cursor_loop_paramContext} from './generated/PlSqlParser.ts';
import {nameInfoOfIdentifier, nameRangeOf, typeReferenceOfElement} from './antlrDeclarationSupport.ts';
import {type OracleDeclarationType, type OracleParseInputType} from './syntax.ts';

const loopIteratorName = (parameter: Cursor_loop_paramContext | null): ReturnType<typeof nameInfoOfIdentifier> | null => {
	const identifier = parameter?.index_name()?.identifier() ?? parameter?.record_name()?.identifier() ?? null;

	return identifier === null ? null : nameInfoOfIdentifier(identifier);
};

/**
 * Returns nested block and loop contexts in source order.
 *
 * Nested routine bodies are skipped: their declarations are collected when the
 * enclosing block declares the routine.
 *
 * @param root - Routine body or package initialization section.
 * @returns Nested declaration-bearing contexts.
 */
export const nestedDeclarationContexts = (root: ParserRuleContext): readonly (BlockContext | Loop_statementContext)[] => {
	const contexts: (BlockContext | Loop_statementContext)[] = [];

	const visit = (node: ParserRuleContext): void => {
		if (node instanceof Procedure_bodyContext || node instanceof Function_bodyContext) {
			return;
		}

		if (node instanceof BlockContext || node instanceof Loop_statementContext) {
			contexts.push(node);
		}

		for (let index = 0; index < node.getChildCount(); index += 1) {
			const child = node.getChild(index);

			if (child instanceof ParserRuleContext) {
				visit(child);
			}
		}
	};

	visit(root);

	return contexts.sort((left, right) => (left.start?.start ?? 0) - (right.start?.start ?? 0));
};

/**
 * Builds the implicit declaration for a numeric or cursor loop iterator.
 *
 * @param input - Source text and workspace path.
 * @param loop - Loop statement.
 * @param parent - Enclosing routine or package declaration index.
 * @param unit - Owning unit index.
 * @param exported - Whether the enclosing scope is exported.
 * @returns The iterator declaration, or null when the loop has no authored name.
 */
export const loopIteratorDeclarationOf = (
	input: Readonly<{
		source: OracleParseInputType;
		loop: Loop_statementContext;
		parent: number;
		unit: number;
		exported: boolean;
	}>,
): OracleDeclarationType | null => {
	const parameter = input.loop.cursor_loop_param();
	const info = loopIteratorName(parameter);

	if (info === null) {
		return null;
	}

	const nameRange = nameRangeOf(input.source, info);
	const cursorElement = parameter?.cursor_name()?.general_element() ?? null;
	const typeReference = cursorElement === null ? null : typeReferenceOfElement(input.source, cursorElement);

	return {
		kind: 'variable',
		name: info.name,
		range: nameRange,
		nameRange,
		parent: input.parent,
		unit: input.unit,
		exported: input.exported,
		parameters: [],
		typeReferences: typeReference === null ? [] : [typeReference],
	};
};
