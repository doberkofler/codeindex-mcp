import {type Node, type Program, type SourceFile, type Symbol as TsSymbol, type TypeChecker} from 'typescript';
import {type FactRangeType} from '../../core/facts/index.ts';

export type CandidateScopeType = Readonly<{kind: 'module'; path: string}> | Readonly<{kind: 'global'}> | Readonly<{kind: 'external_module'; target: string}>;

export type CandidateDefinitionType = Readonly<{
	readonly declaration: Node;
	readonly nameNode: Node;
	readonly kind: string;
	readonly path: string;
	readonly sourceFile: SourceFile;
	readonly range: FactRangeType;
	readonly extent: FactRangeType;
	readonly forwardDefinition: boolean;
	readonly primaryRank: number;
	readonly anchorRank: number;
}>;

export type CandidateType = Readonly<{
	readonly key: string;
	readonly canonical: TsSymbol | null;
	readonly name: string;
	readonly kind: string;
	readonly path: string;
	readonly sourceFile: SourceFile;
	readonly scope: CandidateScopeType;
	readonly definitions: readonly CandidateDefinitionType[];
	readonly primary: CandidateDefinitionType;
	readonly externalTarget: string | null;
	readonly externalName: string | null;
	readonly synthetic: boolean;
}>;

export type DeferredCandidateType = Readonly<{
	readonly canonical: TsSymbol;
	readonly declaration: Node;
	readonly nameNode: Node;
	readonly kind: string;
	readonly path: string;
	readonly sourceFile: SourceFile;
	readonly scope: CandidateScopeType;
}>;

export type CandidateCollectionType = Readonly<{
	readonly candidates: ReadonlyMap<string, CandidateType>;
	readonly symbolKeys: ReadonlyMap<TsSymbol, string>;
	readonly declarationKeys: ReadonlyMap<Node, string>;
	readonly deferred: ReadonlyMap<Node, DeferredCandidateType>;
	readonly ephemeralKinds: ReadonlyMap<string, number>;
	readonly externalAliases: number;
	readonly externalStars: number;
	readonly mergedDeclarationCount: number;
}>;

export type CandidateInputType = Readonly<{
	readonly checker: TypeChecker;
	readonly program: Program;
	readonly files: readonly {readonly path: string; readonly absolutePath: string}[];
	readonly rootDir: string;
	readonly projectId: string;
	readonly context: string;
	readonly authoredPaths: ReadonlySet<string>;
	readonly pathByAbsolute: ReadonlyMap<string, string>;
}>;
