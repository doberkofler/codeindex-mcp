import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {indexRootDirectory} from '../../../config/config.ts';
import {oracleQualificationContractIdentityOf} from '../oracleQualificationContract.ts';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const EnvironmentSchema = z.object({
	CODEINDEX_EVIDENCE_ROOT: z.string().min(1).optional(),
});

const DescriptorSchema = z.object({
	schemaVersion: z.literal(1),
	evidence: z.object({
		externalRoot: z.string().min(1),
		snapshotDir: z.string().min(1),
		plan: z.string().min(1),
		run: z.string().min(1),
		approval: Sha256Schema,
	}),
	source: z.object({
		kind: z.string().min(1),
		revision: z.string().min(1),
		relativeRoot: z.string().min(1),
		defaultSchema: z.string().min(1),
	}),
	snapshot: z.object({
		projectFile: z.string().min(1),
		sourceHash: Sha256Schema,
		configHash: Sha256Schema,
		fileCount: z.number().int().positive(),
		unitCount: z.number().int().positive(),
	}),
	files: z.object({
		checksums: z.string().min(1),
		units: z.string().min(1),
	}),
});

const UnitSchema = z.object({
	path: z.string().min(1),
	type: z.string().min(1),
	name: z.string().min(1),
	sourceSha256: Sha256Schema,
});

const PlanSchema = z.object({
	version: z.number().int().positive(),
	approval: Sha256Schema,
	snapshot: z.object({
		sourceHash: z.string().min(1),
		configHash: z.string().min(1),
		files: z.array(z.object({path: z.string().min(1), sha256: z.string().min(1)})),
		projectFiles: z.array(z.object({path: z.string().min(1), sha256: z.string().min(1)})).optional(),
	}),
});

const ContractSchema = z.object({
	id: z.string().min(1),
	version: z.string().min(1),
	hash: Sha256Schema,
	truthPolicy: z.string().min(1),
});

const RunSchema = z.object({
	version: z.number().int().positive(),
	approval: Sha256Schema,
	source: z.object({
		sourceHash: z.string().min(1),
		configHash: z.string().min(1),
		files: z.number().int().nonnegative(),
	}),
	contract: ContractSchema.optional(),
	truth: z
		.object({
			identifiersSha256: Sha256Schema,
			dependenciesSha256: Sha256Schema,
		})
		.optional(),
});

type DescriptorType = z.infer<typeof DescriptorSchema>;
type PlanType = z.infer<typeof PlanSchema>;
type RunType = z.infer<typeof RunSchema>;
type UnitType = z.infer<typeof UnitSchema>;
type ChecksumType = Readonly<{sha256: string; file: string}>;

/** Outcome of one artifact or identity check. */
type OracleEvidenceStatusType = 'ok' | 'missing' | 'mismatch' | 'unverified';

type OracleEvidenceArtifactType = Readonly<{
	/** Bundle-relative POSIX path, never an absolute private path. */
	path: string;
	kind: string;
	status: OracleEvidenceStatusType;
	detail: string | null;
}>;

type OracleEvidenceIdentityType = Readonly<{
	name: string;
	status: OracleEvidenceStatusType;
	expected: string;
	actual: string;
}>;

export type OracleEvidencePreflightReportType = Readonly<{
	version: 1;
	descriptor: string;
	root: string;
	ok: boolean;
	artifacts: readonly OracleEvidenceArtifactType[];
	identities: readonly OracleEvidenceIdentityType[];
	summary: Readonly<{ok: number; missing: number; mismatch: number; unverified: number}>;
}>;

type PreflightInputType = Readonly<{
	/** Path to the committed bundle descriptor, for example `benchmark/oracle-production-20261027/corpus.json`. */
	descriptorPath: string;
	/** Overrides the resolved external evidence root. */
	evidenceRoot?: string | undefined;
}>;

type ManifestsType = Readonly<{
	corpusChecksums: readonly ChecksumType[];
	truthChecksums: readonly ChecksumType[];
	units: readonly UnitType[];
}>;

type BundleType = Readonly<{
	descriptor: DescriptorType;
	root: string;
	snapshotDir: string;
	manifests: ManifestsType;
	truthHashes: ReadonlyMap<string, string>;
	plan: PlanType | null;
	run: RunType | null;
}>;

/** Artifacts the frozen bundle must retain regardless of its checksum manifest. */
const REQUIRED_BUNDLE_ARTIFACTS = ['user-identifiers.csv', 'user-dependencies.csv', 'user-source-backup.csv', 'compile.log', 'dependents.log'] as const;

const readSchema = async <T>(schema: z.ZodType<T>, filePath: string): Promise<T> => schema.parse(JSON.parse(await readFile(filePath, 'utf8')));

const parseChecksums = (text: string, sourcePath: string): readonly ChecksumType[] =>
	text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line, index) => {
			const match = /^(?<sha256>[a-f0-9]{64}) [ *](?<file>.+)$/u.exec(line.trimEnd());
			const sha256 = match?.groups?.['sha256'];
			const file = match?.groups?.['file'];

			if (sha256 === undefined || file === undefined) {
				throw new Error(`Malformed checksum line ${String(index + 1)} in ${sourcePath}`);
			}

			return {sha256, file};
		});

const fileKindOf = async (filePath: string): Promise<'file' | 'directory' | null> => {
	try {
		const info = await stat(filePath);

		return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
	} catch {
		return null;
	}
};

const hashFileOf = async (filePath: string): Promise<string> =>
	createHash('sha256')
		.update(await readFile(filePath))
		.digest('hex');

const statusesOf = (statuses: readonly OracleEvidenceStatusType[]): OracleEvidencePreflightReportType['summary'] => ({
	ok: statuses.filter((status) => status === 'ok').length,
	missing: statuses.filter((status) => status === 'missing').length,
	mismatch: statuses.filter((status) => status === 'mismatch').length,
	unverified: statuses.filter((status) => status === 'unverified').length,
});

const presenceArtifactOf = async (kind: string, relativePath: string, absolutePath: string): Promise<OracleEvidenceArtifactType> =>
	(await fileKindOf(absolutePath)) === null
		? {path: relativePath, kind, status: 'missing', detail: null}
		: {path: relativePath, kind, status: 'ok', detail: null};

const digestArtifactOf = async (
	kind: string,
	relativePath: string,
	absolutePath: string,
	expected: string | undefined,
): Promise<OracleEvidenceArtifactType> => {
	if ((await fileKindOf(absolutePath)) === null) {
		return {path: relativePath, kind, status: 'missing', detail: null};
	}

	if (expected === undefined) {
		return {path: relativePath, kind, status: 'unverified', detail: 'no retained checksum'};
	}

	const actual = await hashFileOf(absolutePath);

	return actual === expected
		? {path: relativePath, kind, status: 'ok', detail: null}
		: {path: relativePath, kind, status: 'mismatch', detail: `sha256 ${actual}`};
};

const identityOf = (name: string, expected: string, actual: string): OracleEvidenceIdentityType => ({
	name,
	status: expected === actual ? 'ok' : 'mismatch',
	expected,
	actual,
});

const missingIdentityOf = (name: string, expected: string, actual: string): OracleEvidenceIdentityType => ({name, status: 'missing', expected, actual});

const loadManifests = async (
	descriptor: DescriptorType,
	descriptorDir: string,
): Promise<Readonly<{manifests: ManifestsType | null; artifacts: readonly OracleEvidenceArtifactType[]}>> => {
	const checksumPath = path.resolve(descriptorDir, descriptor.files.checksums);
	const unitsPath = path.resolve(descriptorDir, descriptor.files.units);
	const plscopePath = path.join(descriptorDir, 'plscope.sha256');
	const artifacts = await Promise.all([
		presenceArtifactOf('checksum-manifest', descriptor.files.checksums, checksumPath),
		presenceArtifactOf('unit-map', descriptor.files.units, unitsPath),
		presenceArtifactOf('checksum-manifest', 'plscope.sha256', plscopePath),
	]);

	if (artifacts.some((artifact) => artifact.status !== 'ok')) {
		return {manifests: null, artifacts};
	}

	return {
		manifests: {
			corpusChecksums: parseChecksums(await readFile(checksumPath, 'utf8'), descriptor.files.checksums),
			truthChecksums: parseChecksums(await readFile(plscopePath, 'utf8'), 'plscope.sha256'),
			units: z.array(UnitSchema).parse(JSON.parse(await readFile(unitsPath, 'utf8'))),
		},
		artifacts,
	};
};

const bundleOf = async (descriptor: DescriptorType, root: string, manifests: ManifestsType): Promise<BundleType> => {
	const planPath = path.resolve(root, descriptor.evidence.plan);
	const runPath = path.resolve(root, descriptor.evidence.run);

	return {
		descriptor,
		root,
		snapshotDir: path.resolve(root, descriptor.evidence.snapshotDir),
		manifests,
		truthHashes: new Map(manifests.truthChecksums.map((entry) => [entry.file, entry.sha256])),
		plan: (await fileKindOf(planPath)) === null ? null : await readSchema(PlanSchema, planPath),
		run: (await fileKindOf(runPath)) === null ? null : await readSchema(RunSchema, runPath),
	};
};

const artifactKindOf = (bundle: BundleType, name: string): string =>
	name === bundle.descriptor.evidence.plan ? 'plan' : name === bundle.descriptor.evidence.run ? 'run' : 'truth-artifact';

const bundleArtifactsOf = async (bundle: BundleType): Promise<readonly OracleEvidenceArtifactType[]> => {
	const {descriptor, root, snapshotDir} = bundle;
	const projectHash = bundle.plan?.snapshot.projectFiles?.find((entry) => entry.path === descriptor.snapshot.projectFile)?.sha256;
	const required = new Set([descriptor.evidence.plan, descriptor.evidence.run, ...REQUIRED_BUNDLE_ARTIFACTS]);
	const names = [...new Set([...required, ...bundle.truthHashes.keys()])].sort((left, right) => left.localeCompare(right));
	const snapshotPromises = [
		presenceArtifactOf('snapshot-root', descriptor.evidence.snapshotDir, snapshotDir),
		digestArtifactOf(
			'snapshot-file',
			`${descriptor.evidence.snapshotDir}/${descriptor.snapshot.projectFile}`,
			path.resolve(snapshotDir, descriptor.snapshot.projectFile),
			projectHash,
		),
	];
	const externalPromises: Promise<OracleEvidenceArtifactType>[] = [];

	for (const entry of bundle.manifests.corpusChecksums) {
		snapshotPromises.push(
			digestArtifactOf('snapshot-file', `${descriptor.evidence.snapshotDir}/${entry.file}`, path.resolve(snapshotDir, entry.file), entry.sha256),
		);
	}

	for (const name of names) {
		externalPromises.push(digestArtifactOf(artifactKindOf(bundle, name), name, path.resolve(root, name), bundle.truthHashes.get(name)));
	}

	return [...(await Promise.all(snapshotPromises)), ...(await Promise.all(externalPromises))];
};

const corpusIdentitiesOf = (bundle: BundleType): readonly OracleEvidenceIdentityType[] => {
	const {descriptor, manifests} = bundle;
	const corpusPaths = new Set(manifests.corpusChecksums.map((entry) => entry.file));
	const unitPaths = new Set(manifests.units.map((unit) => unit.path));
	const unmatchedUnits = [...corpusPaths].filter((file) => !unitPaths.has(file)).length + [...unitPaths].filter((file) => !corpusPaths.has(file)).length;

	return [
		identityOf('corpus.fileCount', String(descriptor.snapshot.fileCount), String(manifests.corpusChecksums.length)),
		identityOf('corpus.unitCount', String(descriptor.snapshot.unitCount), String(manifests.units.length)),
		identityOf('corpus.unitFiles', String(descriptor.snapshot.fileCount), String(manifests.units.length)),
		identityOf('corpus.unitPaths', '0 unmatched units', `${String(unmatchedUnits)} unmatched units`),
	];
};

const planIdentitiesOf = (bundle: BundleType): readonly OracleEvidenceIdentityType[] => {
	const {descriptor, plan} = bundle;

	if (plan === null) {
		return [missingIdentityOf('plan.*', 'verified plan', 'missing plan')];
	}

	const listedProjectFile = plan.snapshot.projectFiles?.some((entry) => entry.path === descriptor.snapshot.projectFile) === true;

	return [
		identityOf('plan.approval', descriptor.evidence.approval, plan.approval),
		identityOf('plan.sourceHash', descriptor.snapshot.sourceHash, plan.snapshot.sourceHash),
		identityOf('plan.configHash', descriptor.snapshot.configHash, plan.snapshot.configHash),
		identityOf('plan.fileCount', String(descriptor.snapshot.fileCount), String(plan.snapshot.files.length)),
		identityOf('plan.projectFile', 'listed with checksum', listedProjectFile ? 'listed with checksum' : 'unlisted'),
	];
};

const truthIdentityOf = (name: string, expected: string | undefined, actual: string | undefined): OracleEvidenceIdentityType =>
	expected === undefined || actual === undefined
		? missingIdentityOf(name, expected ?? 'unavailable', actual ?? 'unrecorded')
		: identityOf(name, expected, actual);

const contractIdentityOf = (run: RunType): OracleEvidenceIdentityType => {
	const contract = oracleQualificationContractIdentityOf();
	const expected = `${contract.id}@${contract.version} policy ${contract.truthPolicy} hash ${contract.hash}`;
	const actual =
		run.contract === undefined ? 'unrecorded' : `${run.contract.id}@${run.contract.version} policy ${run.contract.truthPolicy} hash ${run.contract.hash}`;

	return identityOf('run.contract', expected, actual);
};

const runIdentitiesOf = (bundle: BundleType): readonly OracleEvidenceIdentityType[] => {
	const {descriptor, run, truthHashes} = bundle;

	if (run === null) {
		return [missingIdentityOf('run.*', 'verified run metadata', 'missing run metadata')];
	}

	return [
		identityOf('run.approval', descriptor.evidence.approval, run.approval),
		identityOf('run.sourceHash', descriptor.snapshot.sourceHash, run.source.sourceHash),
		identityOf('run.configHash', descriptor.snapshot.configHash, run.source.configHash),
		identityOf('run.fileCount', String(descriptor.snapshot.fileCount), String(run.source.files)),
		contractIdentityOf(run),
		truthIdentityOf('run.truthIdentifiers', truthHashes.get('user-identifiers.csv'), run.truth?.identifiersSha256),
		truthIdentityOf('run.truthDependencies', truthHashes.get('user-dependencies.csv'), run.truth?.dependenciesSha256),
	];
};

/**
 * Verifies a retained Oracle qualification evidence bundle without touching a
 * database or an index.
 *
 * The check is read-only and DB-free by design: it must be able to reject a
 * missing or mismatched bundle before any Oracle session capable of DDL is
 * opened. Every artifact is resolved relative to the external evidence root, so
 * no absolute private path enters the committed descriptor.
 *
 * @param environment - Environment source; only `CODEINDEX_EVIDENCE_ROOT` is read.
 * @param input - Committed descriptor path and optional evidence-root override.
 * @returns Deterministic preflight report; `ok` is true only when every check passed.
 * @throws {Error} When the descriptor, a checksum manifest, or a JSON artifact is malformed.
 */
export const preflightOracleEvidenceBundle = async (environment: NodeJS.ProcessEnv, input: PreflightInputType): Promise<OracleEvidencePreflightReportType> => {
	const descriptorPath = path.resolve(input.descriptorPath);
	const descriptor = await readSchema(DescriptorSchema, descriptorPath);
	const descriptorDir = path.dirname(descriptorPath);
	const parsedEnvironment = EnvironmentSchema.parse(environment);
	const root = path.resolve(
		input.evidenceRoot ?? path.join(parsedEnvironment.CODEINDEX_EVIDENCE_ROOT ?? indexRootDirectory(), descriptor.evidence.externalRoot),
	);
	const loaded = await loadManifests(descriptor, descriptorDir);
	const bundle = loaded.manifests === null ? null : await bundleOf(descriptor, root, loaded.manifests);
	const artifacts = [...loaded.artifacts, ...(bundle === null ? [] : await bundleArtifactsOf(bundle))];
	const identities = bundle === null ? [] : [...corpusIdentitiesOf(bundle), ...planIdentitiesOf(bundle), ...runIdentitiesOf(bundle)];
	const summary = statusesOf([...artifacts.map((artifact) => artifact.status), ...identities.map((identity) => identity.status)]);

	return {
		version: 1,
		descriptor: descriptorPath,
		root,
		ok: summary.missing === 0 && summary.mismatch === 0 && summary.unverified === 0,
		artifacts,
		identities,
		summary,
	};
};
