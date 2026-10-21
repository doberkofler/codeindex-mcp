import {type DiagnosticType} from '../../core/model.ts';
import {type OracleNamePartType, type OracleNameType} from './name.ts';

export type OracleRangeType = Readonly<{
	startOffset: number;
	endOffset: number;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}>;

export type OracleUnitKindType = 'package-spec' | 'package-body' | 'procedure' | 'function';

export type OracleDeclarationKindType =
	| 'package'
	| 'procedure'
	| 'function'
	| 'parameter'
	| 'variable'
	| 'constant'
	| 'cursor'
	| 'ref_cursor_type'
	| 'record_type'
	| 'collection_type'
	| 'subtype'
	| 'exception'
	| 'field';

/**
 * Source form of one routine or cursor declaration.
 *
 * The form decides identity and primary-definition ranking and whether a
 * specification requires a body.
 */
export type OracleDeclarationFormType = 'specification' | 'full_definition' | 'body_forward' | 'call_spec' | 'polymorphic_table_function';

export type OracleTypeReferenceType = Readonly<{
	name: OracleNameType;
	range: OracleRangeType;
	rowType: boolean;
	/** True for a `%TYPE` anchor, whose declared type is unknown statically. */
	anchored: boolean;
}>;

export type OracleParameterType = Readonly<{
	name: OracleNamePartType;
	nameRange: OracleRangeType;
	range: OracleRangeType;
	mode: 'IN' | 'OUT' | 'IN OUT';
	hasDefault: boolean;
	typeText: string;
	typeReferences: readonly OracleTypeReferenceType[];
}>;

export type OracleDeclarationType = Readonly<{
	kind: OracleDeclarationKindType;
	name: OracleNamePartType;
	range: OracleRangeType;
	nameRange: OracleRangeType;
	parent: number | null;
	unit: number;
	/** True for declarations that belong to a package specification or standalone routine. */
	exported: boolean;
	parameters: readonly OracleParameterType[];
	typeReferences: readonly OracleTypeReferenceType[];
	/**
	 * Normalized routine/cursor heading for spec/body pairing; defaults and a
	 * lone `IN` are omitted.
	 */
	heading?: string | undefined;
	/** Recorded form for routine and cursor declarations. */
	form?: OracleDeclarationFormType | undefined;
}>;

export type OracleUnitType = Readonly<{
	kind: OracleUnitKindType;
	schema: OracleNamePartType;
	name: OracleNamePartType;
	/** Canonical `SCHEMA.OBJECT` identity. */
	canonical: string;
	range: OracleRangeType;
	nameRange: OracleRangeType;
	declaration: number;
}>;

export type OracleReferenceArgumentType = Readonly<{
	/** Complete authored argument expression range. */
	range: OracleRangeType;
	/** Canonical parameter name for a named association, otherwise null. */
	name: string | null;
	/** Canonical leading name of the argument value, when it starts with one. */
	leadName?: OracleNameType | undefined;
	/** Whether the value ends with an index expression, so its type is the element type. */
	indexed?: boolean | undefined;
	/** Built-in type implied by a literal argument. */
	literalType?: string | undefined;
}>;

export type OracleReferenceSiteType = Readonly<{
	name: OracleNameType;
	/** Range of the complete authored name, including qualifiers. */
	range: OracleRangeType;
	/** Range of the final name segment, which is the referenced identifier. */
	nameRange: OracleRangeType;
	unit: number;
	enclosing: number;
	kind: 'call' | 'reference' | 'type-anchor';
	argumentCount: number | null;
	argumentNames: readonly string[];
	/** Top-level arguments of one call-shaped site, used for OUT usage bits. */
	arguments?: readonly OracleReferenceArgumentType[] | undefined;
	rowType: boolean;
	/** Whether the site is inside a SQL statement. */
	sql?: boolean | undefined;
	/** Whether the site is inside a FOR-loop header. */
	forBound?: boolean | undefined;
	/** Whether the FOR header is a numeric range (`FOR i IN 1 .. n`) rather than a cursor. */
	forRange?: boolean | undefined;
	/** Whether the site is a datatype length or size argument. */
	typeSize?: boolean | undefined;
	/** Whether the site's base name is a loop iterator. */
	iteratorBase?: boolean | undefined;
	/** Whether a call-shaped site is a complete statement rather than an expression. */
	statementCall?: boolean | undefined;
	/** Syntactic usage bit before OUT-argument refinement. */
	usage?: number | undefined;
}>;

export type OracleDependencySiteType = Readonly<{
	targetName: OracleNameType;
	memberName: OracleNamePartType | null;
	range: OracleRangeType;
	unit: number;
	enclosing: number;
	kind: 'package-call' | 'package-reference' | 'type-reference';
}>;

export type OracleParseResultType = Readonly<{
	units: readonly OracleUnitType[];
	declarations: readonly OracleDeclarationType[];
	references: readonly OracleReferenceSiteType[];
	dependencies: readonly OracleDependencySiteType[];
	diagnostics: readonly DiagnosticType[];
}>;

export type OracleParseInputType = Readonly<{
	source: string;
	path: string;
	defaultSchema: string;
}>;

export type OracleParserType = (input: OracleParseInputType) => OracleParseResultType;
