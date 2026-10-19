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
	rowType: boolean;
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
