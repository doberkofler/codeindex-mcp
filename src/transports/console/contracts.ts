import {type IndexStatusType} from '../../core/model.ts';

export const CONSOLE_OPERATIONS = ['update', 'rebuild', 'verify', 'benchmark', 'verify-references', 'mcp-install'] as const;

export type ConsoleOperationType = (typeof CONSOLE_OPERATIONS)[number];

export type ConsoleJobStateType = 'queued' | 'running' | 'succeeded' | 'failed';

export type ConsoleJobType = Readonly<{
	readonly id: string;
	readonly operation: ConsoleOperationType;
	readonly state: ConsoleJobStateType;
	readonly createdAt: string;
	readonly startedAt: string | null;
	readonly completedAt: string | null;
	readonly durationMs: number | null;
	readonly message: string | null;
	readonly result: unknown;
}>;

export type ConsoleMetaType = Readonly<{
	readonly program: string;
	readonly version: string;
	readonly nodeVersion: string;
	readonly schemaVersion: string;
	readonly projectName: string;
	readonly rootDir: string;
	readonly projectFilePath: string;
	readonly extractorId: string;
	readonly extractorVersion: string;
	readonly databasePath: string;
	readonly analyticsPath: string;
	readonly analyticsEnabled: boolean;
	readonly projectId: string;
	readonly maxResultBytes: number;
	readonly maxReadLines: number;
	readonly logLevel: string;
	readonly loopbackOnly: boolean;
	readonly tokenRequired: boolean;
	readonly operations: readonly ConsoleOperationType[];
}>;

export type {AnalyticsDashboardType, AnalyticsToolType, AnalyticsWindowType} from '../../core/analytics/contracts.ts';

export type ConsoleSnapshotType = Readonly<{
	readonly meta: ConsoleMetaType;
	readonly status: IndexStatusType;
	readonly jobs: readonly ConsoleJobType[];
}>;
