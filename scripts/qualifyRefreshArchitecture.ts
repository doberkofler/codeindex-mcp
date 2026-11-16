import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {
	REFRESH_QUALIFICATION_RSS_CEILINGS_BYTES,
	REFRESH_QUALIFICATION_TESTS,
	createRefreshQualificationReport,
} from '../src/core/qualification/refreshQualification.ts';

const root = path.resolve(import.meta.dirname, '..');
const PROCESS_TIMEOUT_MS = 180_000;
const outputArgument = process.argv.indexOf('--output');
const outputPath = outputArgument === -1 ? null : (process.argv.at(outputArgument + 1) ?? null);
if (outputArgument !== -1 && outputPath === null) {
	throw new Error('--output requires a path');
}

const hashFiles = (files: readonly string[]): string => {
	const hash = createHash('sha256');
	for (const file of [...files].sort()) {
		hash.update(file);
		hash.update(readFileSync(path.join(root, file)));
	}
	return hash.digest('hex');
};

type ExecutionType = Readonly<{id: string; durationMs: number; exitCode: number | null; timedOut: boolean}>;

const ceilingEnvironment = (ceiling: number): NodeJS.ProcessEnv => ({
	...process.env,
	CODE_INDEX_BUILD_WORKER_MAX_RSS_BYTES: String(ceiling),
});

const execute = async (id: string, files: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<ExecutionType> => {
	const started = performance.now();
	const child = spawn('pnpm', ['exec', 'vitest', 'run', ...files, '--coverage.enabled=false'], {
		cwd: root,
		detached: true,
		env: environment,
		stdio: 'inherit',
	});
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		if (child.pid !== undefined) {
			process.kill(-child.pid, 'SIGKILL');
		}
	}, PROCESS_TIMEOUT_MS);
	await once(child, 'exit');
	clearTimeout(deadline);
	return {id, durationMs: performance.now() - started, exitCode: child.exitCode, timedOut};
};

const main = async (): Promise<number> => {
	const testFiles = [...new Set(Object.values(REFRESH_QUALIFICATION_TESTS).flat())].sort();
	const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', timeout: 10_000});
	if (revisionResult.status !== 0) {
		throw new Error('git rev-parse failed');
	}
	const revision = revisionResult.stdout.trim();
	const identities = {
		revision,
		runtimeSha256: createHash('sha256').update(`${process.version}\0${process.platform}\0${process.arch}`).digest('hex'),
		configurationSha256: hashFiles([
			'package.json',
			'pnpm-lock.yaml',
			'scripts/qualifyRefreshArchitecture.ts',
			'src/core/qualification/refreshQualification.ts',
			'tsconfig.json',
			'vitest.config.ts',
		]),
		fixturesSha256: hashFiles(testFiles),
	};
	const executions: ExecutionType[] = [await execute('scenario-contract', testFiles)];
	const [ceiling2GiB, ceiling4GiB, ceiling6GiB] = REFRESH_QUALIFICATION_RSS_CEILINGS_BYTES;
	executions.push(
		...(await Promise.all([
			execute(`resource-ceiling-${String(ceiling2GiB)}`, ['test/builtProcess.test.ts', 'test/persistentBuildWorker.test.ts'], ceilingEnvironment(ceiling2GiB)),
			execute(`resource-ceiling-${String(ceiling4GiB)}`, ['test/builtProcess.test.ts', 'test/persistentBuildWorker.test.ts'], ceilingEnvironment(ceiling4GiB)),
			execute(`resource-ceiling-${String(ceiling6GiB)}`, ['test/builtProcess.test.ts', 'test/persistentBuildWorker.test.ts'], ceilingEnvironment(ceiling6GiB)),
		])),
	);
	const report = createRefreshQualificationReport({identities, executions});
	const serialized = `${JSON.stringify(report, null, '\t')}\n`;
	if (outputPath === null) {
		process.stdout.write(serialized);
	} else {
		writeFileSync(path.resolve(outputPath), serialized, 'utf8');
		process.stdout.write(`Refresh qualification: ${report.status}; report ${outputPath}\n`);
	}
	return report.status === 'pass' ? 0 : 1;
};

process.exitCode = await main();
