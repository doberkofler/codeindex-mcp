import {type OracleFileGraphType, type OracleMemberLookupType, type OraclePackageLookupMapType} from './scopeGraph.ts';
import {type MutableBindingType, type OracleParsedFileType} from './symbolTables.ts';

type MutablePackageType = {
	canonical: string;
	packageSymbolId: string;
	specPath: string | null;
	bodyPath: string | null;
	members: OracleMemberLookupType[];
};

const addMember = (packageRecord: MutablePackageType, member: OracleMemberLookupType): void => {
	if (!packageRecord.members.some((existing) => existing.symbolId === member.symbolId)) {
		packageRecord.members.push(member);
	}
};

const addUnitMembers = (
	input: Readonly<{
		file: OracleParsedFileType;
		graph: OracleFileGraphType;
		unitDeclaration: number;
		bindings: readonly MutableBindingType[];
		packageRecord: MutablePackageType;
	}>,
): void => {
	for (const child of input.graph.childrenByParent.get(input.unitDeclaration) ?? []) {
		const declaration = input.file.parse.declarations[child];
		const binding = input.bindings[child];

		if (declaration === undefined || binding === undefined) {
			continue;
		}

		addMember(input.packageRecord, {
			canonical: binding.canonical,
			simpleName: declaration.name.canonical,
			kind: declaration.kind,
			symbolId: binding.symbolId,
			path: input.file.path,
			declarationIndex: child,
			declaration,
			signature: binding.signature,
		});
	}
};

const packageRecordFor = (packages: Map<string, MutablePackageType>, unitCanonical: string, packageSymbolId: string): MutablePackageType => {
	const existing = packages.get(unitCanonical);

	if (existing !== undefined) {
		return existing;
	}

	const created: MutablePackageType = {canonical: unitCanonical, packageSymbolId, specPath: null, bodyPath: null, members: []};
	packages.set(unitCanonical, created);
	return created;
};

const addPackageUnit = (
	input: Readonly<{
		packages: Map<string, MutablePackageType>;
		fileIndex: number;
		file: OracleParsedFileType;
		graph: OracleFileGraphType;
		bindings: readonly MutableBindingType[][];
		unit: OracleParsedFileType['parse']['units'][number];
	}>,
): void => {
	const packageBinding = input.bindings[input.fileIndex]?.[input.unit.declaration];

	if ((input.unit.kind !== 'package-spec' && input.unit.kind !== 'package-body') || packageBinding === undefined) {
		return;
	}

	const existing = packageRecordFor(input.packages, input.unit.canonical, packageBinding.symbolId);

	if (input.unit.kind === 'package-spec') {
		existing.specPath = input.file.path;
		existing.packageSymbolId = packageBinding.symbolId;
	} else {
		existing.bodyPath = input.file.path;
	}

	addUnitMembers({
		file: input.file,
		graph: input.graph,
		unitDeclaration: input.unit.declaration,
		bindings: input.bindings[input.fileIndex] ?? [],
		packageRecord: existing,
	});
};

export const buildPackageLookups = (
	files: readonly OracleParsedFileType[],
	graphs: readonly OracleFileGraphType[],
	bindings: readonly MutableBindingType[][],
): OraclePackageLookupMapType => {
	const packages = new Map<string, MutablePackageType>();

	for (const [fileIndex, file] of files.entries()) {
		const graph = graphs[fileIndex];

		if (graph === undefined) {
			continue;
		}

		for (const unit of file.parse.units) {
			addPackageUnit({packages, fileIndex, file, graph, bindings, unit});
		}
	}

	return packages;
};
