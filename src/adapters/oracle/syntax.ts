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
	/** Normalized routine/cursor heading used for exact spec/body pairing. */
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
