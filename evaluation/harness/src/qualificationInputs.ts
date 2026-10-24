import path from 'node:path';
import {assertCanonicalTreatmentOf, loadCanonicalArtifact, type CanonicalArtifactType} from './canonicalArtifact.ts';
import {evaluationRoot, flagOf, manifestPathOf} from './cliSupport.ts';
import {QUALIFICATION_CASE_COUNT, QUALIFICATION_REPETITIONS, QUALIFICATION_TREATMENT_IDS} from './qualificationContract.ts';
import {caseHashOf, type CaseType, type SuiteType} from './schema.ts';
import {loadSuite, treatmentIdsOf} from './suite.ts';
import {type TreatmentDefinitionType} from './treatment.ts';

/** Frozen release suite that supplies the qualification case corpus. */
const RELEASE_SUITE_PATH = 'suites/release.json';

/** Flags that would change the fixed 108-slot qualification plan or criteria. */
const FIXED_PLAN_FLAGS = ['case', 'tag', 'treatment', 'repetitions', 'target-metric'] as const;

/** Frozen inputs that a qualification campaign and its revalidation share. */
export type QualificationCommonInputsType = Readonly<{
	flags: Map<string, string[]>;
	suite: SuiteType;
	cases: readonly CaseType[];
	canonicalTreatment: TreatmentDefinitionType;
	canonical: CanonicalArtifactType;
}>;

const assertReleaseCorpusOf = (suite: SuiteType, cases: readonly CaseType[]): void => {
	const release = loadSuite(path.resolve(evaluationRoot, RELEASE_SUITE_PATH));

	if (release.suite.status !== 'frozen') {
		throw new Error(`qualification requires the frozen release suite; ${release.suite.id} is ${release.suite.status}`);
	}

	if (release.cases.length !== QUALIFICATION_CASE_COUNT) {
		throw new Error(
			`qualification requires the frozen ${QUALIFICATION_CASE_COUNT}-case release suite; ${release.suite.id} declares ${release.cases.length} case(s)`,
		);
	}

	if (suite.revision !== release.suite.revision) {
		throw new Error(`qualification suite revision ${suite.revision} differs from release suite revision ${release.suite.revision}`);
	}

	const releaseHashes = new Map(release.cases.map((testCase) => [testCase.id, caseHashOf(testCase)]));
	const caseIds = cases.map((testCase) => testCase.id).sort();

	if (caseIds.join(',') !== [...releaseHashes.keys()].sort().join(',')) {
		throw new Error('qualification suite must select exactly the frozen release case set');
	}

	for (const testCase of cases) {
		const pinned = releaseHashes.get(testCase.id);

		if (pinned === undefined || pinned !== caseHashOf(testCase)) {
			throw new Error(`qualification case ${testCase.id} differs from the frozen release case content`);
		}
	}
};

/**
 * Resolves and validates the frozen inputs shared by qualification modes.
 *
 * @param flags - Parsed CLI flags.
 * @returns The frozen suite, cases, and canonical artifact.
 */
export const commonQualificationInputsOf = (flags: Map<string, string[]>): QualificationCommonInputsType => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined || suitePath === 'true') {
		throw new Error('--suite is required');
	}

	for (const forbidden of FIXED_PLAN_FLAGS) {
		if (flags.has(forbidden)) {
			throw new Error(`qualification does not accept --${forbidden}; the frozen qualification plan is fixed`);
		}
	}

	const canonicalPath = manifestPathOf(flags, 'canonical');
	const loaded = loadSuite(path.resolve(evaluationRoot, suitePath));

	if (loaded.suite.status !== 'frozen') {
		throw new Error(`suite ${loaded.suite.id} must be frozen for qualification`);
	}

	if (loaded.cases.length !== QUALIFICATION_CASE_COUNT) {
		throw new Error(
			`qualification requires the frozen ${QUALIFICATION_CASE_COUNT}-case suite; suite ${loaded.suite.id} declares ${loaded.cases.length} case(s)`,
		);
	}

	if (loaded.suite.repetitions !== QUALIFICATION_REPETITIONS) {
		throw new Error(`qualification requires ${QUALIFICATION_REPETITIONS} paired repetitions; suite ${loaded.suite.id} declares ${loaded.suite.repetitions}`);
	}

	const treatmentIds = treatmentIdsOf(loaded.suite.treatments);

	if (treatmentIds.join(',') !== QUALIFICATION_TREATMENT_IDS.join(',')) {
		throw new Error(
			`qualification requires treatments ${QUALIFICATION_TREATMENT_IDS.join(', ')}; suite ${loaded.suite.id} declares ${treatmentIds.join(', ')}`,
		);
	}

	const canonicalTreatment = loaded.suite.treatments.find((treatment) => treatment.id === 'canonical');

	if (canonicalTreatment === undefined) {
		throw new Error(`suite ${loaded.suite.id} declares no canonical treatment`);
	}

	const canonical = loadCanonicalArtifact(canonicalPath);

	assertCanonicalTreatmentOf(canonical, canonicalTreatment);
	assertReleaseCorpusOf(loaded.suite, loaded.cases);

	return {flags, suite: loaded.suite, cases: loaded.cases, canonicalTreatment, canonical};
};
