import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';

const {basename, dirname, join} = path;
const OWNER_FILE_PATTERN = /\.owner-(?<pid>\d+)-[0-9a-f-]+\.json$/u;

const OwnerSchema = z.object({
	pid: z.number().int().positive(),
	ownerId: z.string().min(1),
	startedAt: z.string().min(1),
});

export type ProcessOwnerType = Readonly<{
	readonly pid: number;
	readonly file: string;
	release: () => void;
}>;

export type ActiveProcessOwnerType = Readonly<{
	readonly pid: number;
	readonly file: string;
	readonly startedAt: string;
}>;

/**
 * Registers one live process against a database file.
 *
 * The marker lets offline commands distinguish a database that is in active use
 * from an abandoned cache without inspecting command lines. The caller must
 * release it when the database closes.
 *
 * @param databasePath - Database file that the current process is opening.
 * @returns The ownership marker and its release function.
 */
export const registerProcessOwner = (databasePath: string): ProcessOwnerType => {
	const directory = dirname(databasePath);
	mkdirSync(directory, {recursive: true});
	const ownerId = randomUUID();
	const file = join(directory, `${basename(databasePath)}.owner-${String(process.pid)}-${ownerId}.json`);

	writeFileSync(file, JSON.stringify({pid: process.pid, ownerId, startedAt: new Date().toISOString()}), {encoding: 'utf8', mode: 0o600});

	return {
		pid: process.pid,
		file,
		release: (): void => {
			rmSync(file, {force: true});
		},
	};
};

const errorCodeOf = (error: unknown): string | null =>
	typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM still means a process exists but belongs to another user.
		return errorCodeOf(error) === 'EPERM';
	}
};

/**
 * Lists live processes that still own a database in one directory.
 *
 * Owner markers written by dead processes are ignored, so a crash never blocks
 * cleanup permanently.
 *
 * @param directory - Directory that holds database owner markers.
 * @returns Live owners with their marker paths.
 */
export const activeProcessOwnersInDirectory = (directory: string): readonly ActiveProcessOwnerType[] => {
	if (!existsSync(directory)) {
		return [];
	}

	let names: readonly string[];

	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}

	return names.flatMap((name) => {
		const match = OWNER_FILE_PATTERN.exec(name);

		if (match === null) {
			return [];
		}

		const file = join(directory, name);

		try {
			const parsed = OwnerSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));

			if (!parsed.success || !isProcessAlive(parsed.data.pid)) {
				return [];
			}

			return [{pid: parsed.data.pid, file, startedAt: parsed.data.startedAt}];
		} catch {
			return [];
		}
	});
};
