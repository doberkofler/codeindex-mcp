import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createOracleLivePlan} from '../src/core/qualification/oracle/live/oracleLivePlan.ts';
import {recompileOracleDependents, recompileOracleObjects} from '../src/core/qualification/oracle/live/oracleRecompile.ts';
import {createFixtureConfig} from './helpers/fixture.ts';
import {installedSourcesOf, settingsOf} from './helpers/oracleLive.ts';

const fixture = (): ReturnType<typeof createFixtureConfig> => createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

const scriptOf = (rootDir: string, name: string, content: string): string => {
	const scriptPath = path.join(rootDir, name);

	writeFileSync(scriptPath, content, {encoding: 'utf8', mode: 0o755});
	return scriptPath;
};

describe.skipIf(process.platform === 'win32')('Oracle SQL*Plus runner', () => {
	it('streams output lines and reports per-object progress', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const sqlplus = scriptOf(
				context.config.rootDir,
				'sqlplus-stream.sh',
				"#!/bin/sh\ncat > /dev/null\nprintf 'RECOMPILE:PACKAGE:HR_API\\n'\nprintf 'RECOMPILE:PACKAGE BODY:HR_API'\n",
			);
			const progress: string[] = [];

			await recompileOracleObjects(
				plan,
				{...settingsOf(outputDir, plan.approval), sqlplus},
				{},
				{
					progress: (line) => {
						progress.push(line);
					},
				},
			);

			expect(progress).toContain(`Recompiling ${String(plan.snapshot.units.length)} target objects...`);
			expect(progress).toContain(`Targets: 1/${String(plan.snapshot.units.length)} HR_API`);
			expect(progress).toContain(`Targets: 2/${String(plan.snapshot.units.length)} HR_API`);
		} finally {
			context.cleanup();
		}
	});

	it('recompiles dependents with a dependent progress label', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const dependencies = [{name: 'HR_VIEW', type: 'VIEW', referencedName: 'HR_API', referencedType: 'PACKAGE'}];
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir), installedSourcesOf(context.config), dependencies);
			const sqlplus = scriptOf(context.config.rootDir, 'sqlplus-dependent.sh', "#!/bin/sh\ncat > /dev/null\nprintf 'RECOMPILE-DEPENDENT:VIEW:HR_VIEW\\n'\n");
			const progress: string[] = [];

			await recompileOracleDependents(
				plan,
				{...settingsOf(outputDir, plan.approval), sqlplus},
				{},
				{
					progress: (line) => {
						progress.push(line);
					},
				},
			);

			expect(progress).toContain('Recompiling 1 dependent objects...');
			expect(progress).toContain('Dependents: 1/1 HR_VIEW');
		} finally {
			context.cleanup();
		}
	});

	it('does not start SQL*Plus when a plan has no dependents', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			let started = false;

			await recompileOracleDependents(
				plan,
				settingsOf(outputDir, plan.approval),
				{},
				{
					runner: () => {
						started = true;
						return {status: 0, stdout: '', stderr: ''};
					},
				},
			);

			expect(started).toBe(false);
		} finally {
			context.cleanup();
		}
	});
});

describe.skipIf(process.platform === 'win32')('Oracle SQL*Plus runner failures', () => {
	it('reports SQL*Plus stderr when recompilation fails', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const sqlplus = scriptOf(context.config.rootDir, 'sqlplus-fail.sh', "#!/bin/sh\ncat > /dev/null\nprintf 'ORA-04063: view has errors\\n' >&2\nexit 1\n");

			await expect(recompileOracleObjects(plan, {...settingsOf(outputDir, plan.approval), sqlplus}, {})).rejects.toThrow(
				/Oracle recompile step failed[\s\S]*ORA-04063/u,
			);
		} finally {
			context.cleanup();
		}
	});

	it('reports a spawn failure', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const sqlplus = path.join(context.config.rootDir, 'missing-sqlplus');

			await expect(recompileOracleObjects(plan, {...settingsOf(outputDir, plan.approval), sqlplus}, {})).rejects.toThrow(/Oracle recompile step failed/u);
		} finally {
			context.cleanup();
		}
	});

	it('terminates SQL*Plus on timeout', async () => {
		const context = fixture();

		try {
			const outputDir = path.join(path.dirname(context.config.rootDir), 'qualification');
			const plan = createOracleLivePlan(context.config, settingsOf(outputDir));
			const sqlplus = scriptOf(context.config.rootDir, 'sqlplus-slow.sh', '#!/bin/sh\ncat > /dev/null\nexec sleep 5\n');

			await expect(recompileOracleObjects(plan, {...settingsOf(outputDir, plan.approval), sqlplus, timeoutMs: 50}, {})).rejects.toThrow(
				/Oracle recompile step failed[\s\S]*timed out/u,
			);
		} finally {
			context.cleanup();
		}
	});
});
