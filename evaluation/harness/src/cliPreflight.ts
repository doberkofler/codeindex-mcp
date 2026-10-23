import path from 'node:path';
import {allOf, artifactsOf, evaluationRoot, evaluationStateRoot, flagOf, primaryCheckout, settingsOf} from './cliSupport.ts';
import {assertCorpusPreflight, corpusPreflightOf} from './corpusPreflight.ts';
import {writeJsonAtomic} from './result.ts';
import {loadSuite, selectCases, treatmentIdsOf} from './suite.ts';
import {subjectIdentityOf, workspaceContextOf} from './workspace.ts';
import {ensureWorkspaces} from './workspaceRestore.ts';

const progressOf = (report: Awaited<ReturnType<typeof corpusPreflightOf>>, directory: string): void => {
	process.stdout.write(`corpus preflight ${report.result.toUpperCase()}\n`);

	for (const project of report.projects) {
		process.stdout.write(`project ${project.name} ${project.projectFile}\n`);
	}

	for (const treatment of report.treatments) {
		process.stdout.write(
			`index ${treatment.treatmentId} ready=${String(treatment.ready)} contexts=${treatment.contexts.join(',')} files=${treatment.fileCount} project-files=${treatment.projectFiles.join(',')} unindexed=${treatment.unindexedPaths.length}\n`,
		);
	}

	for (const failure of report.failures) {
		process.stdout.write(`FAIL ${failure}\n`);
	}

	process.stdout.write(`report ${path.join(directory, 'preflight.json')}\n`);
};

/**
 * Proves every selected case corpus is configured and indexed before model spend.
 *
 * @param flags - Parsed CLI flags.
 */
export const preflightCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});
	const treatments = suite.treatments.filter((treatment) => treatment.kind === 'codeindex');
	const settings = settingsOf();
	const subject = subjectIdentityOf(settings.subjectRepo, suite.revision);
	const context = workspaceContextOf(evaluationStateRoot, {subjectRepo: settings.subjectRepo, subject, evaluationRoot, primaryCheckout});
	const directory = path.join(evaluationStateRoot, 'results', 'preflight', `${suite.id}-${suite.hash.slice(0, 16)}`);

	ensureWorkspaces(context, suite.treatments);
	artifactsOf(context, treatments);

	const report = await corpusPreflightOf({context, cases: selected, treatments});

	writeJsonAtomic(path.join(directory, 'preflight.json'), report, true);
	progressOf(report, directory);
	assertCorpusPreflight(report);

	process.stdout.write(`treatments ${treatmentIdsOf(treatments).join(', ')}\n`);
};
