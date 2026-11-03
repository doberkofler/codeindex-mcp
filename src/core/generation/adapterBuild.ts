import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {type AdapterConfigType, type ConfigType, configuredAdapters} from '../config/config.ts';
import {type ScanResultType} from '../model.ts';
import {type ExtractorType} from '../../adapters/types.ts';
import {type AdapterSetType} from '../../adapters/loader.ts';
import {ADAPTER_PROTOCOL_VERSION} from '@codeindex/adapter-sdk';

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
	/** Protocol revision declared by the loaded module. */
	readonly protocolVersion: number;
	/** Bounded installed package name, or null for a local module. */
	readonly packageName: string | null;
	/** Bounded installed package version, or null when unavailable. */
	readonly packageVersion: string | null;
}>;

/** Raised when the adapter set itself violates the contract. */
export class AdapterContractError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'AdapterContractError';
	}
}

/**
 * Resolves every configured adapter to its loaded implementation.
 *
 * @param config - Resolved configuration.
 * @param adapters - Loaded adapter set.
 * @param override - Optional qualification-only extractor for a singular config.
 * @returns Adapter targets in declaration order.
 */
export const adapterTargets = (config: ConfigType, adapters: AdapterSetType, override?: ExtractorType): readonly AdapterTargetType[] => {
	const configured = configuredAdapters(config);

	if (override !== undefined) {
		const [adapter] = configured;

		if (adapter === undefined || configured.length !== 1) {
			throw new AdapterContractError('An extractor override requires exactly one configured adapter');
		}

		return [
			{
				adapter,
				extractor: override,
				protocolVersion: ADAPTER_PROTOCOL_VERSION,
				packageName: null,
				packageVersion: null,
			},
		];
	}

	return configured.map((adapter) => {
		const extractor = adapters.byId.get(adapter.id);

		if (extractor === undefined) {
			throw new AdapterContractError(`Adapter ${adapter.id} is not loaded`);
		}

		if (extractor.id !== adapter.id) {
			throw new AdapterContractError(`Adapter ${adapter.id} resolved to ${extractor.id}`);
		}

		const descriptor = adapters.descriptors.find((candidate) => candidate.id === adapter.id);

		return {
			adapter,
			extractor,
			protocolVersion: descriptor?.protocolVersion ?? ADAPTER_PROTOCOL_VERSION,
			packageName: descriptor?.packageName ?? null,
			packageVersion: descriptor?.packageVersion ?? null,
		};
	});
};

/**
 * Probes one adapter before scanning.
 *
 * @param target - Configured adapter and implementation.
 * @param config - Resolved configuration scoped by the caller.
 * @returns Declared absence, or present when the adapter may run.
 */
export const probeAdapter = async (
	target: AdapterTargetType,
	config: ConfigType,
): Promise<Readonly<{coverage: 'present'}> | {coverage: 'absent'; reason: string}> => {
	if (target.extractor.probe === undefined) {
		return {coverage: 'present'};
	}

	const result = await target.extractor.probe(config);

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
 * Records one path owner, rejecting a second adapter for the same identity.
 *
 * @param owners - Identity to adapter map.
 * @param identity - Resolved path identity or workspace-relative path.
 * @param relativePath - Workspace-relative path used in the message.
 * @param adapterId - Adapter claiming the path.
 * @throws {@link AdapterContractError} When another adapter already owns the identity.
 */
const claimPath = (owners: Map<string, string>, identity: string, relativePath: string, adapterId: string): void => {
	const existing = owners.get(identity);

	if (existing !== undefined && existing !== adapterId) {
		throw new AdapterContractError(`Adapter ownership conflict: ${relativePath} is claimed by ${existing} and ${adapterId}`);
	}

	owners.set(identity, adapterId);
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
			claimPath(owners, identity, file.path, plan.adapterId);
		}
	}
};

/**
 * Re-validates path ownership on the final extracted file sets.
 *
 * Extraction can publish more files than the scan manifest carried, so the
 * scan-time check cannot prove uniqueness of the rows that are about to be
 * written. A conflict here fails the candidate with an adapter ownership cause
 * instead of surfacing as a primary-key violation during publication.
 *
 * @param adapters - Extracted adapters with their final file sets.
 * @throws {@link AdapterContractError} When two adapters claim one path.
 */
export const assertSharedExtractedFiles = (adapters: readonly Readonly<{adapterId: string; files: readonly Readonly<{path: string}>[]}>[]): void => {
	const owners = new Map<string, string>();

	for (const adapter of adapters) {
		for (const file of adapter.files) {
			claimPath(owners, file.path, file.path, adapter.adapterId);
		}
	}
};

/** One identifier class validated across adapters. */
type IdentityFactsType = Readonly<{
	readonly kind: string;
	readonly ids: (adapter: AdapterIdentitySourceType) => readonly string[];
}>;

/** Identity classes validated across adapters. */
const IDENTITY_FACTS: readonly IdentityFactsType[] = [
	{kind: 'symbol', ids: (adapter) => adapter.facts?.symbols.map((symbol) => symbol.id) ?? []},
	{kind: 'binding', ids: (adapter) => adapter.facts?.bindings.map((binding) => binding.bindingId) ?? []},
	{kind: 'dependency', ids: (adapter) => adapter.dependencies?.edges.map((edge) => edge.id) ?? []},
];

/** One adapter's extracted facts, as needed for cross-adapter identity checks. */
type AdapterIdentitySourceType = Readonly<{
	readonly adapterId: string;
	readonly coverage: AdapterCoverageType;
	readonly facts?:
		| Readonly<{
				readonly symbols: readonly Readonly<{id: string}>[];
				readonly bindings: readonly Readonly<{bindingId: string}>[];
		  }>
		| undefined;
	readonly dependencies?:
		| Readonly<{
				readonly edges: readonly Readonly<{id: string}>[];
		  }>
		| undefined;
}>;

/**
 * Rejects identity reused by two adapters in one generation.
 *
 * Adapter-local identifiers are anchored to the adapter's own project paths, so
 * a cross-adapter duplicate is an adapter defect. It is never merged, renamed,
 * or resolved last-writer-wins.
 *
 * @param adapters - Extracted adapters and their fact bundles.
 * @throws {@link AdapterContractError} When two adapters emit the same identifier.
 */
export const assertAdapterIdentity = (adapters: readonly AdapterIdentitySourceType[]): void => {
	const present = adapters.filter((adapter) => adapter.coverage === 'present');

	for (const {kind, ids} of IDENTITY_FACTS) {
		const owners = new Map<string, string>();

		for (const adapter of present) {
			for (const id of ids(adapter)) {
				const existing = owners.get(id);

				if (existing !== undefined && existing !== adapter.adapterId) {
					throw new AdapterContractError(`Adapter identity collision: ${kind} ${id} is claimed by ${existing} and ${adapter.adapterId}`);
				}

				owners.set(id, adapter.adapterId);
			}
		}
	}
};
