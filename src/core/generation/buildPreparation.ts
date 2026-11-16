import {type AdapterExecutionContextType} from '@codeindex/adapter-sdk';
import {type AdapterSetType} from '../../adapters/loader.ts';
import {type ExtractorType} from '../../adapters/types.ts';
import {adapterConfigFor, type ConfigType} from '../config/config.ts';
import {type GenerationAdapterType, type GenerationRowType, type ScanResultType} from '../model.ts';
import {type IndexDatabase} from '../storage/database.ts';
import {AdapterContractError, adapterTargets, assertSharedPaths, probeAdapter, type AdapterScanPlanType, type AdapterTargetType} from './adapterBuild.ts';
import {runAdapterStageAsync, runBuildStageAsync} from './buildFailure.ts';

export type BuildPreparationInputType = Readonly<{
	config: ConfigType;
	database: IndexDatabase;
	scans?: readonly AdapterScanPlanType[];
	scan?: ScanResultType;
	extractor?: ExtractorType;
	adapters: AdapterSetType;
	adapterIds?: readonly string[] | null;
	executionContext?: AdapterExecutionContextType | undefined;
}>;

export type PreparedBuildType = Readonly<{
	published: GenerationRowType | null;
	scans: readonly AdapterScanPlanType[];
	targets: readonly AdapterTargetType[];
	previousAdapters: readonly GenerationAdapterType[];
}>;

const suppliedScanPlans = (input: BuildPreparationInputType, targets: readonly AdapterTargetType[]): readonly AdapterScanPlanType[] | null => {
	if (input.scan !== undefined) {
		const [target] = targets;

		if (target === undefined || targets.length !== 1) {
			throw new AdapterContractError('A singular scan requires exactly one configured adapter');
		}

		return [{adapterId: target.adapter.id, coverage: 'present', absenceReason: null, scan: input.scan}];
	}

	if (input.scans === undefined) {
		return null;
	}

	const configured = new Set(targets.map((target) => target.adapter.id));

	for (const plan of input.scans) {
		if (!configured.has(plan.adapterId)) {
			throw new AdapterContractError(`Scan plan names an unconfigured adapter: ${plan.adapterId}`);
		}

		if (plan.scan !== null && plan.scan.extractorId !== plan.adapterId) {
			throw new AdapterContractError(`Scan plan for ${plan.adapterId} carries facts from ${plan.scan.extractorId}`);
		}
	}

	if (new Set(input.scans.map((plan) => plan.adapterId)).size !== input.scans.length) {
		throw new AdapterContractError('Scan plans name an adapter more than once');
	}

	return input.scans;
};

const scanPlansOf = async (
	input: BuildPreparationInputType,
	targets: readonly AdapterTargetType[],
	published: GenerationRowType | null,
): Promise<readonly AdapterScanPlanType[]> => {
	const supplied = suppliedScanPlans(input, targets);

	if (supplied !== null) {
		return supplied;
	}

	const plans: AdapterScanPlanType[] = [];

	for (const target of targets) {
		input.executionContext?.throwIfCancellationRequested();
		const scoped = adapterConfigFor(input.config, target.adapter);
		// Adapter probes are sequential so absence and failure attribution follow
		// configuration order.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const probe = await runAdapterStageAsync(target.adapter.id, async () => {
			const result = await probeAdapter(target, scoped);
			return result;
		});

		if (probe.coverage === 'absent') {
			plans.push({adapterId: target.adapter.id, coverage: 'absent', absenceReason: probe.reason, scan: null});
			continue;
		}

		const knownPaths = published === null ? [] : input.database.listFiles(published.id, target.adapter.id).map((file) => file.path);
		// Adapter scans are intentionally sequential to preserve deterministic
		// attribution and one active expensive attempt.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const scan = await runAdapterStageAsync(target.adapter.id, async () => {
			const result = await runBuildStageAsync('scan', async () => {
				const scanned = await target.extractor.scan(scoped, knownPaths, input.executionContext);
				return scanned;
			});
			return result;
		});

		plans.push({adapterId: target.adapter.id, coverage: 'present', absenceReason: null, scan});
	}

	return plans;
};

const assertTargetedCoverage = (
	published: GenerationRowType | null,
	scans: readonly AdapterScanPlanType[],
	targets: readonly AdapterTargetType[],
	previousAdapters: readonly GenerationAdapterType[],
): void => {
	const planned = new Set(scans.map((plan) => plan.adapterId));

	if (scans.length === 0) {
		throw new AdapterContractError('A build requires at least one adapter scan plan');
	}

	if (planned.size >= targets.length) {
		return;
	}

	if (published === null) {
		throw new AdapterContractError('A targeted refresh requires a published generation');
	}

	const persisted = new Set(previousAdapters.map((adapter) => adapter.adapterId));

	for (const target of targets) {
		if (!planned.has(target.adapter.id) && !persisted.has(target.adapter.id)) {
			throw new AdapterContractError(`A targeted refresh omitted adapter ${target.adapter.id} without a persisted row`);
		}
	}
};

/**
 * Resolves adapter targets and obtains validated scan plans for one build.
 *
 * @param input - Build configuration, adapters, storage, and optional supplied scans.
 * @returns Published state, scan plans, targets, and previous adapter rows.
 */
export const prepareBuild = async (input: BuildPreparationInputType): Promise<PreparedBuildType> => {
	const published = input.database.getPublishedGeneration();
	const targets = adapterTargets(input.config, input.adapters, input.extractor);
	const selectedTargets =
		input.adapterIds === undefined || input.adapterIds === null ? targets : targets.filter((target) => input.adapterIds?.includes(target.adapter.id) === true);
	const scans = await scanPlansOf(input, selectedTargets.length === 0 ? targets : selectedTargets, published);
	assertSharedPaths(scans);

	const previousAdapters = published === null ? [] : input.database.getGenerationAdapters(published.id);
	assertTargetedCoverage(published, scans, targets, previousAdapters);
	return {published, scans, targets, previousAdapters};
};
