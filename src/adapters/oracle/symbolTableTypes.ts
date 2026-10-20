import {type DiagnosticType, type IndexedSymbolType} from '../../core/model.ts';
import {type OracleFileGraphType, type OraclePackageLookupMapType} from './scopeGraph.ts';
import {type OracleDeclarationType, type OracleParseResultType} from './syntax.ts';

export type OracleParsedFileType = Readonly<{path: string; parse: OracleParseResultType}>;

export type ParameterBindingType = Readonly<{symbolId: string; canonical: string; declaration: OracleDeclarationType}>;

type MappedSpecType = Readonly<{
	fileIndex: number;
	declarationIndex: number;
	parameterBindings: readonly ParameterBindingType[];
}>;

export type MutableBindingType = {
	canonical: string;
	signature: string;
	heading: string;
	symbolId: string;
	definitionOnly: boolean;
	enclosingId: string | null;
	ownSymbol: IndexedSymbolType | null;
	mappedSpec: MappedSpecType | null;
};

export type SpecRoutineType = Readonly<{
	symbolId: string;
	fileIndex: number;
	declarationIndex: number;
	declaration: OracleDeclarationType;
	parameterBindings: readonly ParameterBindingType[];
}>;

export type SpecPackageType = Readonly<{
	packageSymbolId: string;
	fileIndex: number;
	declarationIndex: number;
	routinesByHeading: ReadonlyMap<string, readonly SpecRoutineType[]>;
	routinesByKindName: ReadonlyMap<string, readonly SpecRoutineType[]>;
}>;

export type SymbolTableType = Readonly<{
	graphs: readonly OracleFileGraphType[];
	bindings: readonly MutableBindingType[][];
	packages: OraclePackageLookupMapType;
	diagnostics: readonly DiagnosticType[];
}>;
