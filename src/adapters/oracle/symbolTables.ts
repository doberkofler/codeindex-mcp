import {type IndexedSymbolType} from '../../core/model.ts';
import {ORACLE_DIAGNOSTIC, OracleDiagnosticCollector} from './diagnostics.ts';
import {buildFileGraph, type OracleFileGraphType} from './scopeGraph.ts';
import {createOracleId} from './symbolIdentity.ts';
import {mergeForwardDeclarations} from './forwardDeclarations.ts';
import {buildPackageLookups} from './packageLookups.ts';
import {buildSpecIndex, matchSpecRoutine} from './specIndex.ts';
import {type MutableBindingType, type OracleParsedFileType, type SpecPackageType, type SymbolTableType} from './symbolTableTypes.ts';
import {type OracleDeclarationType, type OracleParseResultType} from './syntax.ts';

export type {MutableBindingType, OracleParsedFileType, SymbolTableType} from './symbolTableTypes.ts';

const symbolIdOrNull = (symbolId: string | undefined): string | null => (symbolId === undefined || symbolId === '' ? null : symbolId);

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
	parse.declarations.map((declaration, index) => ({
		canonical: graph.canonicals[index] ?? '',
		signature: graph.signatures[index] ?? '',
		heading: declaration.heading ?? '',
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
		heading: input.declaration.heading ?? '',
		symbolId: id,
		definitionOnly: false,
		enclosingId: input.enclosingId,
		ownSymbol: symbol,
		mappedSpec: null,
	};
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
		matchedSpecRoutines: Set<string>;
		diagnostics: OracleDiagnosticCollector;
	}>,
): boolean => {
	const spec = input.specs.get(input.unitCanonical);
	const match = spec === undefined ? {routine: null, ambiguous: false} : matchSpecRoutine(spec, input.binding.heading);
	const {routine} = match;

	if (routine === null) {
		if (match.ambiguous) {
			input.diagnostics.add(
				ORACLE_DIAGNOSTIC.pairingAmbiguous,
				`Ambiguous specification heading for ${input.binding.canonical}`,
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

	if (input.declaration.form === 'full_definition') {
		input.matchedSpecRoutines.add(`${String(routine.fileIndex)}\u0000${String(routine.declarationIndex)}`);
	}

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
		matchedSpecRoutines: Set<string>;
		diagnostics: OracleDiagnosticCollector;
	}>,
): boolean => {
	const {declaration, binding, unit} = input;
	const {kind} = declaration;

	return declaration.parent === unit.declaration && (kind === 'procedure' || kind === 'function' || kind === 'cursor')
		? mapBodyRoutine({
				declaration,
				binding,
				unitCanonical: unit.canonical,
				parentSymbolId: symbolIdOrNull(input.parentBinding?.symbolId),
				fallbackFileIndex: input.fileIndex,
				specs: input.specs,
				matchedSpecRoutines: input.matchedSpecRoutines,
				diagnostics: input.diagnostics,
			})
		: false;
};

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
		matchedSpecRoutines: Set<string>;
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

	if (
		mapBodyRoutineDeclaration({
			declaration,
			binding,
			unit,
			fileIndex: input.fileIndex,
			parentBinding,
			specs: input.specs,
			matchedSpecRoutines: input.matchedSpecRoutines,
			diagnostics: input.diagnostics,
		})
	) {
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
			enclosingId: symbolIdOrNull(parentBinding?.symbolId),
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
		matchedSpecRoutines: Set<string>;
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

			const enclosingId = declaration.parent === null ? null : symbolIdOrNull(input.bindings[fileIndex]?.[declaration.parent]?.symbolId);
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

const reportMissingBodies = (
	specs: ReadonlyMap<string, SpecPackageType>,
	matchedSpecRoutines: ReadonlySet<string>,
	diagnostics: OracleDiagnosticCollector,
): void => {
	for (const spec of specs.values()) {
		for (const routines of spec.routinesByHeading.values()) {
			for (const routine of routines) {
				if (routine.declaration.form !== 'specification') {
					continue;
				}

				if (matchedSpecRoutines.has(`${String(routine.fileIndex)}\u0000${String(routine.declarationIndex)}`)) {
					continue;
				}

				diagnostics.add(
					ORACLE_DIAGNOSTIC.pairingMissingBody,
					`Specification has no full body definition for ${routine.declaration.name.canonical}`,
					routine.declaration.nameRange.startLine,
					routine.declaration.nameRange.startColumn,
				);
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
	const matchedSpecRoutines = new Set<string>();

	for (const [fileIndex, file] of input.files.entries()) {
		const fileBindings = bindings[fileIndex];

		if (fileBindings !== undefined) {
			mapBodyFile({
				fileIndex,
				projectId: input.projectId,
				context: input.context,
				file,
				bindings: fileBindings,
				specs,
				matchedSpecRoutines,
				diagnostics,
			});
		}
	}

	reportMissingBodies(specs, matchedSpecRoutines, diagnostics);
	mergeForwardDeclarations(input.files, bindings);

	return {graphs, bindings, packages: buildPackageLookups(input.files, graphs, bindings), diagnostics: diagnostics.finish()};
};
