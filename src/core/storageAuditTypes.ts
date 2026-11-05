import {type WalPolicyType} from './storage/walPolicy.ts';

/** Closed artifact categories reported by the storage audit. */
export const STORAGE_AUDIT_CATEGORIES = [
	'index_database',
	'analytics',
	'schema_backup',
	'repository_output',
	'benchmark_cache',
	'evidence_bundle',
	'evaluation_state',
] as const;

export type StorageAuditCategoryType = (typeof STORAGE_AUDIT_CATEGORIES)[number];

export type StorageAuditReasonType = 'active_owner';

/** One normalized, non-overlapping artifact entry. */
export type StorageAuditEntryType = Readonly<{
	readonly category: StorageAuditCategoryType;
	/** `$HOME`/`$REPO`-normalized path. */
	readonly path: string;
	readonly bytes: number;
	readonly logicalBytes: number;
	readonly rawKiB: number;
	readonly files: number;
	readonly cleanupEligible: boolean;
	readonly reason: StorageAuditReasonType | null;
}>;

export type StorageAuditCategoryTotalType = Readonly<{
	readonly category: StorageAuditCategoryType;
	readonly bytes: number;
	readonly logicalBytes: number;
	readonly rawKiB: number;
	readonly files: number;
	readonly entries: number;
}>;

type StorageAuditActiveOwnerType = Readonly<{
	readonly pid: number;
	readonly startedAt: string;
	readonly path: string;
}>;

export type StorageAuditWorktreeType = Readonly<{
	readonly path: string;
	readonly head: string | null;
	readonly branch: string | null;
	readonly state: 'clean' | 'dirty' | 'unknown';
	/** Worktrees are never removable by the audit or by automatic cleanup. */
	readonly removable: false;
}>;

export type StorageAuditWalDatabaseType = Readonly<{
	/** `$HOME`/`$REPO`-normalized index directory. */
	readonly path: string;
	readonly databaseBytes: number;
	readonly walBytes: number;
	readonly shmBytes: number;
	readonly limitBytes: number;
	readonly withinLimit: boolean;
}>;

type StorageAuditWalType = Readonly<{
	readonly policy: WalPolicyType;
	readonly databases: readonly StorageAuditWalDatabaseType[];
	readonly databaseBytes: number;
	readonly walBytes: number;
	readonly shmBytes: number;
	readonly limitBytes: number;
	readonly withinLimit: boolean;
}>;

type StorageAuditGitType = Readonly<{
	readonly commit: string | null;
	readonly directoryBytes: number;
	readonly directoryLogicalBytes: number;
	readonly directoryRawKiB: number;
	readonly worktreeCount: number;
	readonly dirtyWorktreeCount: number;
}>;

export type StorageAuditReportType = Readonly<{
	readonly schemaVersion: 2;
	readonly generatedAt: string;
	readonly sizeSemantics: 'allocated' | 'logical';
	readonly repository: string;
	readonly home: string;
	readonly totals: Readonly<{
		readonly bytes: number;
		readonly logicalBytes: number;
		readonly rawKiB: number;
		readonly files: number;
		readonly entries: number;
	}>;
	readonly categories: readonly StorageAuditCategoryTotalType[];
	readonly entries: readonly StorageAuditEntryType[];
	readonly activeOwners: readonly StorageAuditActiveOwnerType[];
	readonly worktrees: readonly StorageAuditWorktreeType[];
	readonly wal: StorageAuditWalType;
	readonly git: StorageAuditGitType;
	readonly excluded: readonly string[];
	/** Stable digest of the normalized inventory, ignoring the generated timestamp. */
	readonly inventorySha256: string;
}>;

export type StorageAuditRootsType = Readonly<{
	readonly home: string;
	readonly repository: string;
	readonly storageRoots: readonly string[];
	readonly cacheRoots: readonly string[];
	readonly evidenceRoots: readonly string[];
	readonly evaluationRoots: readonly string[];
	readonly temporaryDirectory: string;
}>;

export type StorageAuditInputType = Readonly<{
	readonly home: string;
	readonly repository: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly temporaryDirectory?: string;
	readonly now?: Date;
}>;

/** Internal inventory result before report aggregation. */
export type StorageAuditInventoryType = Readonly<{
	readonly entries: readonly StorageAuditEntryType[];
	readonly activeOwners: readonly StorageAuditActiveOwnerType[];
	readonly worktrees: readonly StorageAuditWorktreeType[];
	readonly walDatabases: readonly StorageAuditWalDatabaseType[];
	readonly commit: string | null;
	readonly gitDirectoryBytes: number;
	readonly gitDirectoryLogicalBytes: number;
}>;
