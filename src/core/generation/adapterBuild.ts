import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {type AdapterConfigType, type ConfigType, configuredAdapters} from '../config/config.ts';
import {type ScanResultType} from '../model.ts';
import {type ExtractorType} from '../../adapters/types.ts';

const {isAbsolute} = path;

/** Closed coverage of one adapter within one attempt. */
type AdapterCoverageType = 'present' | 'absent';

/**
 * One adapter's scan result for a build attempt.
 *
 * Serializable so the same plan crosses the worker boundary unchanged.
 */
export type AdapterScanPlanType = Readonly<{
	readonly adapterId: string;
	readonly coverage: AdapterCoverageType;
	readonly absenceReason: string | null;
	readonly scan: ScanResultType | null;
}>;

/** Adapter configuration paired with its registered implementation. */
export type AdapterTargetType = Readonly<{
	readonly adapter: AdapterConfigType;
	readonly extractor: ExtractorType;
}>;

/** Raised when the adapter set itself violates the contract. */
export class AdapterContractError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'AdapterContractError';
	}
}

/**
 * Resolves every configured adapter to its registered implementation.
 *
 * @param config - Resolved configuration.
 * @param resolve - Registry lookup.
 * @param override - Optional qualification-only extractor for a singular config.
 * @returns Adapter targets in declaration order.
 */
export const adapterTargets = (config: ConfigType, resolve: (id: string) => ExtractorType, override?: ExtractorType): readonly AdapterTargetType[] => {
	const adapters = configuredAdapters(config);

	if (override !== undefined) {
		const [adapter] = adapters;

		if (adapter === undefined || adapters.length !== 1) {
			throw new AdapterContractError('An extractor override requires exactly one configured adapter');
		}

		return [{adapter, extractor: override}];
	}

	return adapters.map((adapter) => {
		const extractor = resolve(adapter.id);

		if (extractor.id !== adapter.id) {
			throw new AdapterContractError(`Adapter ${adapter.id} resolved to ${extractor.id}`);
		}

		return {adapter, extractor};
	});
};

/**
 * Probes one adapter before scanning.
 *
 * @param target - Configured adapter and implementation.
 * @param config - Resolved configuration scoped by the caller.
 * @returns Declared absence, or present when the adapter may run.
 */
export const probeAdapter = (target: AdapterTargetType, config: ConfigType): Readonly<{coverage: 'present'} | {coverage: 'absent'; reason: string}> => {
	if (target.extractor.probe === undefined) {
		return {coverage: 'present'};
	}

	const result = target.extractor.probe(config);

	if (result.available) {
		return {coverage: 'present'};
	}

	if (!(target.extractor.absenceReasons ?? []).includes(result.reason)) {
		throw new AdapterContractError(`Adapter ${target.adapter.id} reported an undeclared absence reason`);
	}

	if (target.adapter.required) {
		throw new AdapterContractError(`Adapter ${target.adapter.id} is unavailable`);
	}

	return {coverage: 'absent', reason: result.reason};
};

const hashOf = (entries: readonly Readonly<{adapterId: string; coverage: AdapterCoverageType; reason: string | null; hash: string}>[]): string =>
	createHash('sha256')
		.update(
			[...entries]
				.sort((left, right) => left.adapterId.localeCompare(right.adapterId))
				.map((entry) => `${entry.adapterId}\u0000${entry.coverage === 'absent' ? `absent:${entry.reason ?? 'unknown'}` : entry.hash}`)
				.join('\n'),
		)
		.digest('hex');

export type AdapterHashEntryType = Readonly<{
	adapterId: string;
	coverage: AdapterCoverageType;
	reason: string | null;
	sourceHash: string;
	configHash: string;
	inputHash: string;
}>;

/**
 * Combines committed per-adapter fingerprints into one generation fingerprint.
 *
 * Committed hashes are authoritative: an adapter that extracted may publish more
 * files than its scan manifest carried, and the next scan then includes them.
 *
 * @param entries - Adapter hashes.
 * @returns Combined source, configuration, and input hashes.
 */
export const combinedAdapterHashesOf = (entries: readonly AdapterHashEntryType[]): Readonly<{sourceHash: string; configHash: string; inputHash: string}> => {
	if (entries.length === 1) {
		const [entry] = entries;

		if (entry !== undefined) {
			return entry.coverage === 'absent'
				? {
						sourceHash: `absent:${entry.reason ?? 'unknown'}`,
						configHash: `absent:${entry.reason ?? 'unknown'}`,
						inputHash: `absent:${entry.reason ?? 'unknown'}`,
					}
				: {sourceHash: entry.sourceHash, configHash: entry.configHash, inputHash: entry.inputHash};
		}
	}

	return {
		sourceHash: hashOf(entries.map((entry) => ({adapterId: entry.adapterId, coverage: entry.coverage, reason: entry.reason, hash: entry.sourceHash}))),
		configHash: hashOf(entries.map((entry) => ({adapterId: entry.adapterId, coverage: entry.coverage, reason: entry.reason, hash: entry.configHash}))),
		inputHash: hashOf(entries.map((entry) => ({adapterId: entry.adapterId, coverage: entry.coverage, reason: entry.reason, hash: entry.inputHash}))),
	};
};

/**
 * Combines per-adapter fingerprints into one generation fingerprint.
 *
 * An absent optional adapter contributes a stable marker, so a later successful
 * probe invalidates whole-generation reuse.
 *
 * @param plans - Adapter scan plans.
 * @returns Combined source, configuration, and input hashes.
 */
export const combinedHashesOf = (plans: readonly AdapterScanPlanType[]): Readonly<{sourceHash: string; configHash: string; inputHash: string}> => {
	if (plans.length === 1) {
		const [plan] = plans;

		if (plan !== undefined) {
			if (plan.coverage === 'absent' || plan.scan === null) {
				const marker = `absent:${plan.absenceReason ?? 'unknown'}`;
				return {sourceHash: marker, configHash: marker, inputHash: marker};
			}

			return {
				sourceHash: plan.scan.sourceHash,
				configHash: plan.scan.configHash,
				inputHash: plan.scan.inputHash ?? plan.scan.configHash,
			};
		}
	}

	const entry = (
		plan: AdapterScanPlanType,
		hash: string | undefined,
	): Readonly<{adapterId: string; coverage: AdapterCoverageType; reason: string | null; hash: string}> => ({
		adapterId: plan.adapterId,
		coverage: plan.coverage,
		reason: plan.absenceReason,
		hash: hash ?? '',
	});

	return {
		sourceHash: hashOf(plans.map((plan) => entry(plan, plan.scan?.sourceHash))),
		configHash: hashOf(plans.map((plan) => entry(plan, plan.scan?.configHash))),
		inputHash: hashOf(plans.map((plan) => entry(plan, plan.scan?.inputHash ?? plan.scan?.configHash))),
	};
};

/**
 * Rejects two adapters that claim the same authored path.
 *
 * Ownership is checked on the resolved real path, so symlinked or
 * case-normalized duplicates still conflict.
 *
 * @param plans - Present adapter scan plans.
 * @throws {@link AdapterContractError} When a path has two owners.
 */
export const assertSharedPaths = (plans: readonly AdapterScanPlanType[]): void => {
	const owners = new Map<string, string>();

	for (const plan of plans) {
		if (plan.coverage === 'absent' || plan.scan === null) {
			continue;
		}

		for (const file of plan.scan.files) {
			const identity = isAbsolute(file.absolutePath) ? realpathSync(file.absolutePath) : file.path;
			const existing = owners.get(identity);

			if (existing !== undefined && existing !== plan.adapterId) {
				throw new AdapterContractError(`Adapter ownership conflict: ${file.path} is claimed by ${existing} and ${plan.adapterId}`);
			}

			owners.set(identity, plan.adapterId);
		}
	}
};
