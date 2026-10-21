import {readFileSync} from 'node:fs';
import path from 'node:path';
import {caseHashOf, caseOf, hashOf, suiteFieldsOf, suiteHashOf, type CaseType, type SuiteType} from './schema.ts';
import {TREATMENT_IDS, type TreatmentDefinitionType, type TreatmentIdType} from './treatment.ts';

/** Answer contract appended to every case prompt, identical for both arms. */
export const ANSWER_CONTRACT = [
	'',
	'Answer with exactly one JSON object and no other text:',
	'{"files": ["<repository-relative path>", ...], "absent": false}',
	'',
	'List every file that answers the question under "files", using paths relative to the',
	'repository root. Set "absent" to true only when the repository contains nothing that',
	'answers the question; in that case "files" must be empty.',
].join('\n');

/** One planned execution slot. It resolves exactly one treatment. */
export type PlanEntryType<Treatment extends string = string> = Readonly<{
	caseId: string;
	treatment: Treatment;
	repetition: number;
}>;

/** Case and tag filters supplied by the CLI. */
export type SelectionType = Readonly<{
	caseIds?: readonly string[];
	tags?: readonly string[];
}>;

const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as unknown;
	} catch (error) {
		throw new Error(`unable to read JSON at ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
};

const uniqueStrings = (values: readonly string[], field: string): readonly string[] => {
	const unique: string[] = [];

	for (const value of values) {
		if (value.trim().length === 0) {
			throw new Error(`${field} must not contain an empty value`);
		}

		if (!unique.includes(value)) {
			unique.push(value);
		}
	}

	return unique;
};

/**
 * Loads a suite and its referenced cases.
 *
 * Frozen suites pin every case hash. A case whose content no longer matches the
 * pinned hash is rejected; the change requires a new suite version.
 *
 * @param suitePath - Path to the suite manifest.
 * @returns The suite plus its cases in manifest order.
 */
export const loadSuite = (suitePath: string): Readonly<{suite: SuiteType; cases: readonly CaseType[]}> => {
	const fields = suiteFieldsOf(readJson(suitePath));
	const caseDir = path.join(path.dirname(path.dirname(suitePath)), 'cases');
	const cases: CaseType[] = [];
	const seen = new Set<string>();

	for (const id of fields.cases) {
		if (seen.has(id)) {
			throw new Error(`suite lists case "${id}" more than once`);
		}

		seen.add(id);
		const loaded = caseOf(readJson(path.join(caseDir, `${id}.json`)));

		if (loaded.id !== id) {
			throw new Error(`case file for "${id}" declares id "${loaded.id}"`);
		}

		const pinned = fields.caseHashes?.[id];

		if (pinned !== undefined) {
			const actual = caseHashOf(loaded);

			if (actual !== pinned) {
				throw new Error(
					`frozen suite "${fields.id}" pins case "${id}" at ${pinned}, but the loaded content hashes to ${actual}; create a new suite version instead of editing a frozen case`,
				);
			}
		}

		cases.push(loaded);
	}

	if (cases.length === 0) {
		throw new Error('suite selects no cases');
	}

	const suite: SuiteType = {
		...fields,
		cases: cases.map((item) => item.id),
		hash: suiteHashOf(fields, cases),
	};

	return {suite, cases};
};

/**
 * Selects cases deterministically.
 *
 * Repeated case IDs form an ordered union in first-occurrence order. Repeated
 * tags intersect. Case and tag filters combine by intersection. An empty
 * selection is an error before any workspace or process is prepared.
 *
 * @param cases - All cases in suite order.
 * @param selection - Case and tag filters.
 * @returns The selected cases in deterministic order.
 */
export const selectCases = (cases: readonly CaseType[], selection: SelectionType): readonly CaseType[] => {
	const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
	const requestedIds = uniqueStrings(selection.caseIds ?? [], 'case selection');
	const tags = uniqueStrings(selection.tags ?? [], 'tag selection');
	const ordered: CaseType[] = [];

	for (const id of requestedIds) {
		const testCase = byId.get(id);

		if (testCase === undefined) {
			throw new Error(`unknown case "${id}"`);
		}

		ordered.push(testCase);
	}

	const base = ordered.length > 0 ? ordered : cases;
	const selected = base.filter((testCase) => tags.every((tag) => testCase.tags.includes(tag)));

	if (selected.length === 0) {
		throw new Error('case/tag selection is empty');
	}

	return selected;
};

/**
 * Builds the ordered execution plan.
 *
 * @param cases - Selected cases in selection order.
 * @param treatments - Selected treatments in canonical suite order.
 * @param repetitions - Repetitions per case and treatment.
 * @returns One entry per execution slot.
 */
export const planOf = <Treatment extends string>(
	cases: readonly CaseType[],
	treatments: readonly Treatment[],
	repetitions: number,
): readonly PlanEntryType<Treatment>[] => {
	if (!Number.isInteger(repetitions) || repetitions <= 0) {
		throw new Error('repetitions must be a positive integer');
	}

	if (treatments.length === 0) {
		throw new Error('plan selects no treatments');
	}

	if (new Set(treatments).size !== treatments.length) {
		throw new Error('plan selects a treatment more than once');
	}

	const plan = cases.flatMap((testCase) =>
		treatments.flatMap((treatment) =>
			Array.from({length: repetitions}, (_, index) => ({
				caseId: testCase.id,
				treatment,
				repetition: index + 1,
			})),
		),
	);
	const slots = new Set(plan.map((entry) => `${entry.caseId}/${entry.treatment}/${entry.repetition}`));

	if (slots.size !== plan.length) {
		throw new Error('plan contains a duplicate execution slot');
	}

	return plan;
};

/**
 * Resolves the single treatment definition for one plan entry.
 *
 * @param entry - Planned execution slot.
 * @param treatments - Suite treatment definitions.
 * @returns The one matching definition.
 */
export const resolveTreatmentOf = (entry: PlanEntryType, treatments: readonly TreatmentDefinitionType[]): TreatmentDefinitionType => {
	const matches = treatments.filter((treatment) => treatment.id === entry.treatment);

	if (matches.length !== 1) {
		throw new Error(`plan entry ${entry.caseId}/${entry.treatment} resolves ${matches.length} treatments`);
	}

	const [match] = matches;

	if (match === undefined) {
		throw new Error(`plan entry ${entry.caseId}/${entry.treatment} resolves no treatment`);
	}

	return match;
};

/**
 * Lists a suite's treatment ids in canonical order.
 *
 * @param treatments - Suite treatment definitions.
 * @returns Treatment ids in plan order.
 */
export const treatmentIdsOf = (treatments: readonly TreatmentDefinitionType[]): readonly TreatmentIdType[] =>
	treatments
		.slice()
		.sort((left, right) => TREATMENT_IDS.indexOf(left.id) - TREATMENT_IDS.indexOf(right.id))
		.map((treatment) => treatment.id);

/**
 * Hashes an ordered plan.
 *
 * @param plan - Execution plan.
 * @returns Hex digest of the plan.
 */
export const planHashOf = (plan: readonly PlanEntryType[]): string => hashOf(plan);

/**
 * Returns the exact prompt sent to both arms for one case.
 *
 * @param testCase - Case under evaluation.
 * @returns Prompt text with the answer contract appended.
 */
export const promptOf = (testCase: CaseType): string => `${testCase.prompt}${ANSWER_CONTRACT}`;
