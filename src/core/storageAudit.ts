import {createHash} from 'node:crypto';
import {collectStorageAuditInventory} from './storageAuditInventory.ts';
import {discoverStorageAuditRoots, normalizeAuditPath} from './storageAuditRoots.ts';
import {
	STORAGE_AUDIT_CATEGORIES,
	type StorageAuditCategoryTotalType,
	type StorageAuditEntryType,
	type StorageAuditInputType,
	type StorageAuditReportType,
} from './storageAuditTypes.ts';

const entryDigest = (entries: readonly StorageAuditEntryType[]): string =>
	createHash('sha256')
		.update(
			JSON.stringify(
				entries.map((entry) => ({
					category: entry.category,
					path: entry.path,
					bytes: entry.bytes,
					logicalBytes: entry.logicalBytes,
					files: entry.files,
					cleanupEligible: entry.cleanupEligible,
					reason: entry.reason,
				})),
			),
		)
		.digest('hex');

const categoryTotalsOf = (entries: readonly StorageAuditEntryType[]): readonly StorageAuditCategoryTotalType[] =>
	STORAGE_AUDIT_CATEGORIES.map((category) => {
		const selected = entries.filter((entry) => entry.category === category);

		return {
			category,
			bytes: selected.reduce((total, entry) => total + entry.bytes, 0),
			logicalBytes: selected.reduce((total, entry) => total + entry.logicalBytes, 0),
			rawKiB: Math.round(selected.reduce((total, entry) => total + entry.bytes, 0) / 1024),
			files: selected.reduce((total, entry) => total + entry.files, 0),
			entries: selected.length,
		};
	});

/**
 * Collects a read-only inventory of CodeIndex-managed artifacts.
 *
 * The audit never deletes, quarantines, or mutates state. It reports managed
 * indexes, analytics, schema backups, repository-generated output, benchmark
 * caches, evidence bundles, evaluation state, and Git worktrees. `.git` and
 * worktrees are reported separately and are excluded from category totals.
 * OpenCode session storage is never inspected.
 *
 * @param input - Home, repository, environment, and optional deterministic clock.
 * @returns Machine-readable audit report.
 */
export const auditStorage = (input: StorageAuditInputType): StorageAuditReportType => {
	const roots = discoverStorageAuditRoots(input);
	const inventory = collectStorageAuditInventory(roots);
	const categories = categoryTotalsOf(inventory.entries);
	const {worktrees} = inventory;
	const totalBytes = categories.reduce((total, category) => total + category.bytes, 0);

	return {
		schemaVersion: 1,
		generatedAt: (input.now ?? new Date()).toISOString(),
		sizeSemantics: process.platform === 'darwin' ? 'allocated' : 'logical',
		repository: normalizeAuditPath(roots.repository, roots),
		home: normalizeAuditPath(roots.home, roots),
		totals: {
			bytes: totalBytes,
			logicalBytes: categories.reduce((total, category) => total + category.logicalBytes, 0),
			rawKiB: Math.round(totalBytes / 1024),
			files: categories.reduce((total, category) => total + category.files, 0),
			entries: categories.reduce((total, category) => total + category.entries, 0),
		},
		categories,
		entries: inventory.entries,
		activeOwners: inventory.activeOwners,
		worktrees,
		git: {
			commit: inventory.commit,
			directoryBytes: inventory.gitDirectoryBytes,
			directoryLogicalBytes: inventory.gitDirectoryLogicalBytes,
			directoryRawKiB: Math.round(inventory.gitDirectoryBytes / 1024),
			worktreeCount: worktrees.length,
			dirtyWorktreeCount: worktrees.filter((worktree) => worktree.state === 'dirty').length,
		},
		excluded: ['opencode_session_storage'],
		inventorySha256: entryDigest(inventory.entries),
	};
};

const binarySize = (bytes: number): string => {
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes;
	let unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}

	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
};

/**
 * Formats an audit report as a concise human-readable summary.
 *
 * @param report - Report returned by {@link auditStorage}.
 * @returns One display line per section.
 */
export const formatStorageAudit = (report: StorageAuditReportType): readonly string[] => {
	const lines = [
		`Storage audit: ${report.generatedAt}`,
		`repository: ${report.repository} (${report.git.commit ?? 'unknown'})`,
		`size semantics: ${report.sizeSemantics}`,
		...report.categories.map(
			(category) =>
				`${category.category}: ${binarySize(category.bytes)} (${category.rawKiB} KiB, ${category.files} file(s), ${category.entries} entr${category.entries === 1 ? 'y' : 'ies'})`,
		),
		`total: ${binarySize(report.totals.bytes)} (${report.totals.rawKiB} KiB)`,
		`active owners: ${report.activeOwners.length}`,
		...report.activeOwners.map((owner) => `  pid ${owner.pid} ${owner.path}`),
		`worktrees: ${report.git.worktreeCount} (${report.git.dirtyWorktreeCount} dirty, never removable automatically)`,
		...report.worktrees.map((worktree) => `  ${worktree.state} ${worktree.path}`),
		`git: ${binarySize(report.git.directoryBytes)} (${report.git.directoryRawKiB} KiB, reported separately)`,
	];

	return lines;
};
