import {isBuildFailureCause} from '../generation/buildFailureCause.ts';
import {type SoakGateType, type SoakReportType} from './soakTypes.ts';

export type SoakReportBaseType = Omit<SoakReportType, 'gates' | 'passed' | 'blocking'>;

const editGateOf = (report: SoakReportBaseType): SoakGateType => {
	const edits = report.events.flatMap((event) => event.edits);

	return {
		id: 'soak.edit-script-deterministic',
		result: edits.length > 0 && edits.every((edit) => edit.contentChanged) ? 'pass' : 'fail',
		detail: `${String(edits.length)} edits changed file content`,
	};
};

const freshnessGateOf = (report: SoakReportBaseType): SoakGateType => ({
	id: 'soak.event-to-fresh',
	result: report.events.length >= report.plan.rounds + 2 && report.latency.count === report.events.length ? 'pass' : 'fail',
	detail: `${String(report.events.length)} events measured`,
});

const overlapGateOf = (report: SoakReportBaseType, requireBuildOverlap: boolean): SoakGateType => {
	const bursts = report.events.filter((event) => event.kind === 'burst');
	const overlapping = bursts.some((event) => event.overlappedBuild);

	return {
		id: 'soak.edits-during-build',
		result: bursts.length > 0 && (!requireBuildOverlap || overlapping) ? 'pass' : 'fail',
		detail: `${String(bursts.length)} burst event(s), build overlap ${overlapping ? 'observed' : 'not observed'}`,
	};
};

const staleGateOf = (report: SoakReportBaseType): SoakGateType => ({
	id: 'soak.stale-refusal',
	result: report.staleRefusal?.refused === true && report.staleRefusal.contentChanged ? 'pass' : 'fail',
	detail: `read_symbol returned ${report.staleRefusal?.errorCode ?? 'no refusal'}`,
});

const causeGateOf = (report: SoakReportBaseType): SoakGateType => {
	const causes = Object.keys(report.failureCauses);

	return {
		id: 'soak.failure-cause-closed',
		result: report.buildFailures.length >= report.plan.failures && causes.every((cause) => isBuildFailureCause(cause)) ? 'pass' : 'fail',
		detail: `causes ${causes.join(', ') || 'none'}`,
	};
};

const recoveryGateOf = (report: SoakReportBaseType): SoakGateType => ({
	id: 'soak.recovery-unattended',
	result: report.recovery.automatic && report.recovery.manualInterventions === 0 ? 'pass' : 'fail',
	detail: `${String(report.recovery.recoveredFailures)}/${String(report.recovery.injectedFailures)} recovered`,
});

const restartGateOf = (report: SoakReportBaseType): SoakGateType => ({
	id: 'soak.restart-reuse',
	result: report.restarts.length === report.plan.restarts && report.restarts.every((restart) => restart.reused && restart.sameGeneration) ? 'pass' : 'fail',
	detail: `${String(report.restarts.length)} restart(s)`,
});

const retentionGateOf = (report: SoakReportBaseType): SoakGateType => ({
	id: 'soak.retention-policy',
	result: report.retention.satisfied ? 'pass' : 'fail',
	detail: `max generations ${String(report.retention.maxima.generations)}, content ${String(report.retention.maxima.contentVersions)}/${String(report.retention.bounds.contentVersions)}`,
});

const publicationGateOf = (report: SoakReportBaseType): SoakGateType => ({
	id: 'soak.publication-preserved',
	result: report.failures.every((failure) => failure.publicationPreserved && failure.queriesServedWhileFailed) ? 'pass' : 'fail',
	detail: `${String(report.failures.length)} failed build(s)`,
});

/**
 * Evaluates every model-free operational gate.
 *
 * @param report - Report without gates and verdict fields.
 * @param requireBuildOverlap - Whether a burst must observe an active build.
 * @returns Every gate in stable order.
 */
export const gatesOf = (report: SoakReportBaseType, requireBuildOverlap: boolean): readonly SoakGateType[] => [
	editGateOf(report),
	freshnessGateOf(report),
	overlapGateOf(report, requireBuildOverlap),
	staleGateOf(report),
	causeGateOf(report),
	recoveryGateOf(report),
	restartGateOf(report),
	retentionGateOf(report),
	publicationGateOf(report),
];
