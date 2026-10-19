import {type DiagnosticType, type IndexedSymbolType} from '../../core/model.ts';
import {ORACLE_DIAGNOSTIC, OracleDiagnosticCollector} from './diagnostics.ts';
import {buildFileGraph, type OracleFileGraphType, type OraclePackageLookupMapType} from './scopeGraph.ts';
import {createOracleId} from './symbolIdentity.ts';
import {mergeForwardDeclarations} from './forwardDeclarations.ts';
import {buildPackageLookups} from './packageLookups.ts';
import {type OracleDeclarationType, type OracleParseResultType} from './syntax.ts';

export type OracleParsedFileType = Readonly<{path: string; parse: OracleParseResultType}>;

type ParameterBindingType = Readonly<{symbolId: string; canonical: string; declaration: OracleDeclarationType}>;

type MappedSpecType = Readonly<{
	fileIndex: number;
	declarationIndex: number;
	parameterBindings: readonly ParameterBindingType[];
}>;

export type MutableBindingType = {
	canonical: string;
	signature: string;
	symbolId: string;
	definitionOnly: boolean;
	enclosingId: string | null;
	ownSymbol: IndexedSymbolType | null;
	mappedSpec: MappedSpecType | null;
};

type SpecRoutineType = Readonly<{
	symbolId: string;
	declaration: OracleDeclarationType;
	parameterBindings: readonly ParameterBindingType[];
}>;

type SpecPackageType = Readonly<{
	packageSymbolId: string;
	fileIndex: number;
	declarationIndex: number;
	routinesBySignature: ReadonlyMap<string, SpecRoutineType>;
	routinesByFallback: ReadonlyMap<string, readonly SpecRoutineType[]>;
}>;

export type SymbolTableType = Readonly<{
	graphs: readonly OracleFileGraphType[];
	bindings: readonly MutableBindingType[][];
	packages: OraclePackageLookupMapType;
	diagnostics: readonly DiagnosticType[];
}>;

const parameterOrdinal = (parse: OracleParseResultType, index: number): number => {
	const declaration = parse.declarations[index];

	if (declaration?.parent === undefined || declaration.parent === null) {
		return -1;
	}

	let ordinal = 0;

	for (let cursor = 0; cursor < index; cursor += 1) {
		const candidate = parse.declarations[cursor];

		if (candidate?.parent === declaration.parent && candidate.kind === 'parameter') {
			ordinal += 1;
		}
	}

	return ordinal;
};

const emptyBindings = (parse: OracleParseResultType, graph: OracleFileGraphType): MutableBindingType[] =>
	parse.declarations.map((_declaration, index) => ({
		canonical: graph.canonicals[index] ?? '',
		signature: graph.signatures[index] ?? '',
		symbolId: '',
		definitionOnly: false,
		enclosingId: null,
		ownSymbol: null,
		mappedSpec: null,
	}));

const ownBinding = (
	input: Readonly<{
		projectId: string;
		context: string;
		path: string;
		declaration: OracleDeclarationType;
		canonical: string;
		signature: string;
		enclosingId: string | null;
	}>,
): MutableBindingType => {
	const id = createOracleId({
		projectId: input.projectId,
		path: input.path,
		startOffset: input.declaration.nameRange.startOffset,
		kind: input.declaration.kind,
		name: input.declaration.name.canonical,
		discriminator: input.context,
	});
	const symbol: IndexedSymbolType = {
		id,
		name: input.declaration.name.text,
		qualifiedName: input.canonical,
		kind: input.declaration.kind,
		path: input.path,
		startLine: input.declaration.range.startLine,
		startColumn: input.declaration.range.startColumn,
		endLine: input.declaration.range.endLine,
		endColumn: input.declaration.range.endColumn,
		startOffset: input.declaration.range.startOffset,
		endOffset: input.declaration.range.endOffset,
		enclosingId: null,
		contexts: [input.context],
	};

	return {
		canonical: input.canonical,
		signature: input.signature,
		symbolId: id,
		definitionOnly: false,
		enclosingId: input.enclosingId,
		ownSymbol: symbol,
		mappedSpec: null,
	};
};

const parameterBindingsOf = (
	fileIndex: number,
	routineIndex: number,
	files: readonly OracleParsedFileType[],
	bindings: readonly MutableBindingType[][],
): readonly ParameterBindingType[] => {
	const file = files[fileIndex];

	if (file === undefined) {
		return [];
	}

	return file.parse.declarations.flatMap((declaration, index) =>
		declaration.parent === routineIndex && declaration.kind === 'parameter'
			? [{symbolId: bindings[fileIndex]?.[index]?.symbolId ?? '', canonical: bindings[fileIndex]?.[index]?.canonical ?? '', declaration}]
			: [],
	);
};

const addSpecRoutine = (
	input: Readonly<{
		fileIndex: number;
		child: number;
		declaration: OracleDeclarationType;
		binding: MutableBindingType;
		signature: string;
		files: readonly OracleParsedFileType[];
		bindings: readonly MutableBindingType[][];
		routinesBySignature: Map<string, SpecRoutineType>;
		routinesByFallback: Map<string, SpecRoutineType[]>;
	}>,
): void => {
	const routine: SpecRoutineType = {
		symbolId: input.binding.symbolId,
		declaration: input.declaration,
		parameterBindings: parameterBindingsOf(input.fileIndex, input.child, input.files, input.bindings),
	};
	const fallback = `${input.declaration.kind}:${input.binding.canonical}:${input.declaration.parameters.length}`;
	const group = input.routinesByFallback.get(fallback) ?? [];

	input.routinesBySignature.set(input.signature, routine);
	group.push(routine);
	input.routinesByFallback.set(fallback, group);
};

const buildSpecIndex = (
	files: readonly OracleParsedFileType[],
	graphs: readonly OracleFileGraphType[],
	bindings: readonly MutableBindingType[][],
): ReadonlyMap<string, SpecPackageType> => {
	const specs = new Map<string, SpecPackageType>();

	for (const [fileIndex, file] of files.entries()) {
		for (const unit of file.parse.units) {
			const graph = graphs[fileIndex];
			const binding = bindings[fileIndex]?.[unit.declaration];

			if (unit.kind !== 'package-spec' || graph === undefined || binding === undefined) {
				continue;
			}

			const routinesBySignature = new Map<string, SpecRoutineType>();
			const routinesByFallback = new Map<string, SpecRoutineType[]>();

			for (const child of graph.childrenByParent.get(unit.declaration) ?? []) {
				const declaration = file.parse.declarations[child];
				const childBinding = bindings[fileIndex]?.[child];

				if (declaration === undefined || childBinding === undefined || (declaration.kind !== 'procedure' && declaration.kind !== 'function')) {
					continue;
				}

				addSpecRoutine({
					fileIndex,
					child,
					declaration,
					binding: childBinding,
					signature: graph.signatures[child] ?? '',
					files,
					bindings,
					routinesBySignature,
					routinesByFallback,
				});
			}

			specs.set(unit.canonical, {
				packageSymbolId: binding.symbolId,
				fileIndex,
				declarationIndex: unit.declaration,
				routinesBySignature,
				routinesByFallback,
			});
		}
	}

	return specs;
};

const matchSpecRoutine = (spec: SpecPackageType, signature: string, fallback: string): SpecRoutineType | null => {
	const exact = spec.routinesBySignature.get(signature);

	if (exact !== undefined) {
		return exact;
	}

	const candidates = spec.routinesByFallback.get(fallback) ?? [];
	return candidates.length === 1 ? (candidates[0] ?? null) : null;
};

const mapBodyPackage = (input: Readonly<{binding: MutableBindingType; unitCanonical: string; specs: ReadonlyMap<string, SpecPackageType>}>): boolean => {
	const spec = input.specs.get(input.unitCanonical);

	if (spec === undefined) {
		return false;
	}

	input.binding.symbolId = spec.packageSymbolId;
	input.binding.definitionOnly = true;
	input.binding.enclosingId = null;
	input.binding.mappedSpec = {fileIndex: spec.fileIndex, declarationIndex: spec.declarationIndex, parameterBindings: []};
	return true;
};

const mapBodyRoutine = (
	input: Readonly<{
		declaration: OracleDeclarationType;
		binding: MutableBindingType;
		unitCanonical: string;
		parentSymbolId: string | null;
		fallbackFileIndex: number;
		specs: ReadonlyMap<string, SpecPackageType>;
		diagnostics: OracleDiagnosticCollector;
	}>,
): boolean => {
	const spec = input.specs.get(input.unitCanonical);
	const fallback = `${input.declaration.kind}:${input.binding.canonical}:${input.declaration.parameters.length}`;
	const routine = spec === undefined ? null : matchSpecRoutine(spec, input.binding.signature, fallback);

	if (routine === null) {
		if ((spec?.routinesByFallback.get(fallback)?.length ?? 0) > 1) {
			input.diagnostics.add(
				ORACLE_DIAGNOSTIC.ambiguousOverload,
				`Ambiguous specification match for ${input.binding.canonical}`,
				input.declaration.nameRange.startLine,
				input.declaration.nameRange.startColumn,
			);
		}

		return false;
	}

	input.binding.symbolId = routine.symbolId;
	input.binding.definitionOnly = true;
	input.binding.enclosingId = input.parentSymbolId;
	input.binding.mappedSpec = {
		fileIndex: spec?.fileIndex ?? input.fallbackFileIndex,
		declarationIndex: spec?.declarationIndex ?? 0,
		parameterBindings: routine.parameterBindings,
	};
	return true;
};

const mapBodyParameter = (
	input: Readonly<{
		declaration: OracleDeclarationType;
		binding: MutableBindingType;
		parse: OracleParsedFileType['parse'];
		index: number;
		parentBinding: MutableBindingType | undefined;
	}>,
): boolean => {
	const {declaration, binding, parentBinding} = input;

	if (declaration.kind !== 'parameter' || parentBinding?.mappedSpec === null || parentBinding?.mappedSpec === undefined) {
		return false;
	}

	const specParameter = parentBinding.mappedSpec.parameterBindings[parameterOrdinal(input.parse, input.index)];

	if (specParameter === undefined) {
		return false;
	}

	binding.symbolId = specParameter.symbolId;
	binding.definitionOnly = true;
	binding.enclosingId = parentBinding.symbolId;
	return true;
};

const mapBodyRoutineDeclaration = (
	input: Readonly<{
		declaration: OracleDeclarationType;
		binding: MutableBindingType;
		unit: OracleParsedFileType['parse']['units'][number];
		fileIndex: number;
		parentBinding: MutableBindingType | undefined;
		specs: ReadonlyMap<string, SpecPackageType>;
		diagnostics: OracleDiagnosticCollector;
	}>,
): boolean =>
	input.declaration.parent === input.unit.declaration && (input.declaration.kind === 'procedure' || input.declaration.kind === 'function')
		? mapBodyRoutine({
				declaration: input.declaration,
				binding: input.binding,
				unitCanonical: input.unit.canonical,
				parentSymbolId: input.parentBinding?.symbolId ?? null,
				fallbackFileIndex: input.fileIndex,
				specs: input.specs,
				diagnostics: input.diagnostics,
			})
		: false;

const mapBodyDeclaration = (
	input: Readonly<{
		projectId: string;
		context: string;
		fileIndex: number;
		file: OracleParsedFileType;
		index: number;
		declaration: OracleDeclarationType;
		binding: MutableBindingType;
		bindings: readonly MutableBindingType[];
		specs: ReadonlyMap<string, SpecPackageType>;
		diagnostics: OracleDiagnosticCollector;
	}>,
): void => {
	const {declaration, binding, bindings} = input;
	const unit = input.file.parse.units[declaration.unit];

	if (unit?.kind !== 'package-body') {
		return;
	}

	const parentBinding = declaration.parent === null ? undefined : bindings[declaration.parent];

	if (declaration.kind === 'package') {
		mapBodyPackage({binding, unitCanonical: unit.canonical, specs: input.specs});
		return;
	}

	if (mapBodyParameter({declaration, binding, parse: input.file.parse, index: input.index, parentBinding})) {
		return;
	}

	if (mapBodyRoutineDeclaration({declaration, binding, unit, fileIndex: input.fileIndex, parentBinding, specs: input.specs, diagnostics: input.diagnostics})) {
		return;
	}

	Object.assign(
		binding,
		ownBinding({
			projectId: input.projectId,
			context: input.context,
			path: input.file.path,
			declaration,
			canonical: binding.canonical,
			signature: binding.signature,
			enclosingId: parentBinding?.symbolId ?? null,
		}),
	);
};

const mapBodyFile = (
	input: Readonly<{
		fileIndex: number;
		projectId: string;
		context: string;
		file: OracleParsedFileType;
		bindings: MutableBindingType[];
		specs: ReadonlyMap<string, SpecPackageType>;
		diagnostics: OracleDiagnosticCollector;
	}>,
): void => {
	for (const [index, declaration] of input.file.parse.declarations.entries()) {
		const binding = input.bindings[index];

		if (binding !== undefined) {
			mapBodyDeclaration({...input, index, declaration, binding, bindings: input.bindings});
		}
	}
};

const assignOwnBindings = (
	input: Readonly<{
		projectId: string;
		context: string;
		files: readonly OracleParsedFileType[];
		graphs: readonly OracleFileGraphType[];
		bindings: MutableBindingType[][];
	}>,
): void => {
	for (const [fileIndex, file] of input.files.entries()) {
		const graph = input.graphs[fileIndex];

		if (graph === undefined) {
			continue;
		}

		for (const [index, declaration] of file.parse.declarations.entries()) {
			const unit = file.parse.units[declaration.unit];

			if (unit?.kind === 'package-body') {
				continue;
			}

			const enclosingId = declaration.parent === null ? null : (input.bindings[fileIndex]?.[declaration.parent]?.symbolId ?? null);
			const binding = ownBinding({
				projectId: input.projectId,
				context: input.context,
				path: file.path,
				declaration,
				canonical: graph.canonicals[index] ?? '',
				signature: graph.signatures[index] ?? '',
				enclosingId,
			});
			const slot = input.bindings[fileIndex]?.[index];

			if (slot !== undefined) {
				Object.assign(slot, binding);
			}
		}
	}
};

/**
 * Builds per-context symbol bindings and package lookup tables.
 *
 * @param input - Project identity, context name, and parsed files.
 * @returns Graphs, declaration bindings, and package lookups.
 */
export const buildSymbolTable = (input: Readonly<{projectId: string; context: string; files: readonly OracleParsedFileType[]}>): SymbolTableType => {
	const graphs = input.files.map((file) => buildFileGraph(file.parse));
	const bindings = input.files.map((file, index) => emptyBindings(file.parse, graphs[index] ?? buildFileGraph(file.parse)));
	const diagnostics = new OracleDiagnosticCollector(input.context);

	assignOwnBindings({...input, graphs, bindings});

	const specs = buildSpecIndex(input.files, graphs, bindings);

	for (const [fileIndex, file] of input.files.entries()) {
		const fileBindings = bindings[fileIndex];

		if (fileBindings !== undefined) {
			mapBodyFile({fileIndex, projectId: input.projectId, context: input.context, file, bindings: fileBindings, specs, diagnostics});
		}
	}

	mergeForwardDeclarations(input.files, bindings);

	return {graphs, bindings, packages: buildPackageLookups(input.files, graphs, bindings), diagnostics: diagnostics.finish()};
};
