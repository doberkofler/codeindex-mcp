import path from 'node:path';
import {z} from 'zod';

const OracleLiveEnvironmentSchema = z.object({
	CODE_INDEX_ORACLE_SQLPLUS: z.string().min(1).default('sqlplus'),
	CODE_INDEX_ORACLE_SQLPLUS_TIMEOUT_MS: z.coerce.number().int().positive().max(86_400_000).default(600_000),
	CODE_INDEX_ORACLE_APPROVAL: z
		.string()
		.regex(/^[a-f0-9]{64}$/u)
		.optional(),
	ORACLE_SERVER: z.string().min(1).optional(),
	ORACLE_USER: z.string().min(1).optional(),
	ORACLE_PASSWORD: z.string().min(1).optional(),
});

export type OracleConnectionType = Readonly<{
	server: string;
	user: string;
	password: string;
}>;

export type OracleLiveSettingsType = Readonly<{
	outputDir: string;
	sqlplus: string;
	timeoutMs: number;
	approval: string | null;
	connection: OracleConnectionType | null;
}>;

export type OracleLiveSettingsInputType = Readonly<{
	rootDir: string;
	outputDir: string;
	approval?: string | null | undefined;
}>;

const outsideRoot = (rootDir: string, candidate: string): boolean => {
	const relative = path.relative(rootDir, candidate);
	return relative !== '' && (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative));
};

/**
 * Resolves environment-only live Oracle qualification settings.
 *
 * @param environment - Untrusted environment source.
 * @param input - Resolved source root, output directory, and optional approval.
 * @returns Output, SQL*Plus, approval, and optional connection settings.
 * @throws {Error} When the output directory is inside the indexed workspace or
 * the connection is incomplete for an apply run.
 */
export const readOracleLiveSettings = (environment: NodeJS.ProcessEnv, input: OracleLiveSettingsInputType): OracleLiveSettingsType => {
	const parsed = OracleLiveEnvironmentSchema.safeParse(environment);

	if (!parsed.success) {
		throw new Error(`Invalid Oracle live qualification environment:\n${z.prettifyError(parsed.error)}`);
	}

	const outputDir = path.resolve(input.outputDir);

	if (!outsideRoot(input.rootDir, outputDir)) {
		throw new Error(`Oracle qualification output directory must be outside the indexed workspace: ${outputDir}`);
	}

	const connectionValues = [parsed.data.ORACLE_SERVER, parsed.data.ORACLE_USER, parsed.data.ORACLE_PASSWORD];
	const approval = input.approval ?? parsed.data.CODE_INDEX_ORACLE_APPROVAL ?? null;

	if (approval !== null && connectionValues.some((value) => value === undefined)) {
		throw new Error('Oracle live qualification apply requires ORACLE_SERVER, ORACLE_USER, and ORACLE_PASSWORD');
	}

	return {
		outputDir,
		sqlplus: parsed.data.CODE_INDEX_ORACLE_SQLPLUS,
		timeoutMs: parsed.data.CODE_INDEX_ORACLE_SQLPLUS_TIMEOUT_MS,
		approval,
		connection: connectionValues.every((value): value is string => value !== undefined)
			? {server: parsed.data.ORACLE_SERVER ?? '', user: parsed.data.ORACLE_USER ?? '', password: parsed.data.ORACLE_PASSWORD ?? ''}
			: null,
	};
};
