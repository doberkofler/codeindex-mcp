import {type EnvironmentManifestType} from './environment.ts';
import {type HostedReferenceType} from './hostedReference.ts';
import {type ClientStoreType} from './isolation.ts';
import {type planOf} from './suite.ts';
import {type TreatmentDefinitionType} from './treatment.ts';
import {type SubjectIdentityType} from './workspace.ts';

/** Planned campaign facts printed before any process starts. */
export type EvaluationPlanPrintType = Readonly<{
	selected: readonly unknown[];
	treatments: readonly TreatmentDefinitionType[];
	repetitions: number;
	plan: ReturnType<typeof planOf>;
	planHash: string;
	identityDigest: string;
	runDir: string;
	environment: EnvironmentManifestType | null;
	hostedReference: HostedReferenceType | null;
	subject: SubjectIdentityType;
	clientStore: ClientStoreType;
}>;

/**
 * Summarizes the elapsed wall-clock budget.
 *
 * @param budgetMs - Declared budget, or undefined when none was declared.
 * @param startedAt - Campaign start in epoch milliseconds.
 * @param exceeded - Whether a slot was abandoned for budget.
 * @returns The budget record, or null when no budget was declared.
 */
export const budgetOf = (
	budgetMs: number | undefined,
	startedAt: number,
	exceeded: boolean,
): Readonly<{budgetMs: number; elapsedMs: number; exceeded: boolean}> | null => {
	if (budgetMs === undefined) {
		return null;
	}

	const elapsedMs = Date.now() - startedAt;

	return {budgetMs, elapsedMs, exceeded: exceeded || elapsedMs > budgetMs};
};

/**
 * Prints the resolved plan and every pinned identity to stderr.
 *
 * @param setup - Planned campaign facts.
 */
export const printEvaluationPlanOf = (setup: EvaluationPlanPrintType): void => {
	const {selected, treatments, repetitions, plan, planHash, identityDigest, runDir, environment, hostedReference, subject, clientStore} = setup;
	const pinned =
		subject.revision === null
			? `revision=${subject.declaredRevision} (copy) content=${subject.contentManifestHash.slice(0, 16)}`
			: `revision=${subject.revision.slice(0, 7)}`;

	process.stderr.write(
		`run ${runDir}\nplan ${plan.length} execution(s): ${selected.length} case(s) x ${treatments.length} treatment(s) x ${repetitions} repetition(s)\n`,
	);
	process.stderr.write(`plan-hash ${planHash}\nidentity ${identityDigest}\n`);

	if (environment !== null) {
		process.stderr.write(
			`environment ${environment.id} ${environment.model.reference} digest ${environment.model.digest} runtime ollama ${environment.runtime.ollama} / opencode ${environment.runtime.opencode}\n`,
		);
	}

	if (hostedReference !== null) {
		process.stderr.write(
			`hosted ${hostedReference.id} ${hostedReference.reference} released ${hostedReference.releasedAt} opencode ${hostedReference.runtime.opencode}\n`,
		);
	}

	process.stderr.write(
		`isolation ${subject.mode}, ${pinned}, standalone server, client store ${clientStore.mode}${clientStore.path === null ? '' : ` at ${clientStore.path}`}\n`,
	);
};
