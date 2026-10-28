import {
	type Cursor_declarationContext,
	type Exception_declarationContext,
	type Function_bodyContext,
	type Function_specContext,
	type Procedure_bodyContext,
	type Procedure_specContext,
	type Subtype_declarationContext,
	type Type_declarationContext,
	type Variable_declarationContext,
} from './generated/PlSqlParser.ts';

export type OracleMemberContextType = Readonly<{
	pragma_declaration: () => unknown;
	exception_declaration: () => Exception_declarationContext | null;
	procedure_spec: () => Procedure_specContext | null;
	function_spec: () => Function_specContext | null;
	variable_declaration: () => Variable_declarationContext | null;
	subtype_declaration: () => Subtype_declarationContext | null;
	cursor_declaration: () => Cursor_declarationContext | null;
	type_declaration: () => Type_declarationContext | null;
	procedure_body?: () => Procedure_bodyContext | null;
	function_body?: () => Function_bodyContext | null;
}>;
