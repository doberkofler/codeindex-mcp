import {existsSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {compare} from './report.ts';
import {effectiveValidityOf, readResult, type StoredResultType} from './result.ts';
import {type RunResultType} from './runTypes.ts';
import {loadSuite, selectCases, treatmentIdsOf} from './suite.ts';
import {canonicalTreatmentsOf} from './treatment.ts';
import {subjectIdentityOf, workspaceContextOf} from './workspace.ts';
import {ensureWorkspaces} from './workspaceRestore.ts';
import {allOf, artifactsOf, evaluationRoot, flagOf, manifestMetadataOf, settingsOf} from './cliSupport.ts';
import {printSummary} from './cliSummary.ts';

export const listCommand = (flags: Map<string, string[]>): void => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const selected = selectCases(cases, {caseIds: allOf(flags, 'case'), tags: allOf(flags, 'tag')});

	process.stdout.write(`${suite.id} v${suite.version} schema=${suite.schemaVersion} (${suite.status}) model=${suite.model} revision=${suite.revision}\n`);
	process.stdout.write(`treatments ${treatmentIdsOf(suite.treatments).join(', ')}\n`);
	process.stdout.write(`ordinary tools ${suite.treatments[0]?.ordinaryTools.join(', ') ?? 'none'}\n`);

	for (const item of selected) {
		process.stdout.write(`  ${item.id}\t${item.class}\t${item.title}\n`);
	}
};

export const resultsIn = (directory: string, campaignId: string): readonly RunResultType[] => {
	const bySlot = new Map<string, Readonly<{attempt: number; record: StoredResultType}>>();
	const validByIdentity = new Map<string, number>();

	const walk = (current: string): void => {
		for (const entry of readdirSync(current)) {
			const full = path.join(current, entry);

			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}

			const attemptMatch = /^attempt-(?<attempt>\d+)\.json$/u.exec(entry);

			if (attemptMatch?.groups?.['attempt'] === undefined) {
				continue;
			}

			const record = readResult(full);

			if (record === null || effectiveValidityOf(record) !== 'valid') {
				continue;
			}

			if (record.campaignId !== campaignId) {
				throw new Error(`attempt ${full} belongs to campaign ${record.campaignId}, not ${campaignId}`);
			}

			const validCount = (validByIdentity.get(record.identityDigest) ?? 0) + 1;

			if (validCount > 1) {
				throw new Error(`two effectively valid attempts exist for identity ${record.identityDigest}; the campaign is not reportable`);
			}

			validByIdentity.set(record.identityDigest, validCount);

			const attempt = Number(attemptMatch.groups['attempt']);
			const stored = bySlot.get(current);

			if (stored === undefined || attempt > stored.attempt) {
				bySlot.set(current, {attempt, record});
			}
		}
	};

	walk(directory);

	return [...bySlot.values()].map((entry) => entry.record);
};

export const latestRun = (resultsRoot: string): string => {
	const entries = existsSync(resultsRoot) ? readdirSync(resultsRoot).sort() : [];
	const last = entries.at(-1);

	if (last === undefined) {
		throw new Error('no runs recorded');
	}

	return path.join(resultsRoot, last);
};

export const reportCommand = (flags: Map<string, string[]>): void => {
	const runId = flagOf(flags, 'run');
	const resultsRoot = path.join(evaluationRoot, 'results');
	const directory = runId === undefined ? latestRun(resultsRoot) : path.join(resultsRoot, runId);

	if (!existsSync(directory)) {
		throw new Error(`no results at ${directory}`);
	}

	const metadata = manifestMetadataOf(directory);
	const results = resultsIn(directory, metadata.campaignId);

	printSummary(directory, results, compare(results, metadata));
};

export const checkCommand = (flags: Map<string, string[]>): void => {
	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined) {
		throw new Error('--suite is required');
	}

	const {suite, cases} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const settings = settingsOf();
	const subject = subjectIdentityOf(settings.subjectRepo, suite.revision);
	const context = workspaceContextOf(evaluationRoot, {subjectRepo: settings.subjectRepo, subject});
	const treatments = canonicalTreatmentsOf(suite.treatments);

	ensureWorkspaces(context, treatments);
	const artifacts = artifactsOf(context, treatments);
	const classes = new Set(cases.map((item) => item.class));

	process.stdout.write(`suite ${suite.id} v${suite.version}, ${cases.length} case(s), classes ${[...classes].join(', ')}\n`);
	process.stdout.write(`model ${suite.model}, revision ${suite.revision}\n`);
	process.stdout.write(`treatments ${treatmentIdsOf(suite.treatments).join(', ')}\n`);
	process.stdout.write(`ordinary tools ${suite.treatments[0]?.ordinaryTools.join(', ') ?? 'none'}\n`);
	process.stdout.write(
		`subject ${subject.mode}, revision ${subject.revision ?? subject.declaredRevision}, content ${subject.contentManifestHash}, lock ${subject.lockFileHash ?? 'none'}\n`,
	);

	for (const treatment of treatments) {
		const artifact = artifacts.get(treatment.id) ?? null;

		process.stdout.write(`artifact ${treatment.id} ${artifact === null ? 'none' : `${artifact.id} ${artifact.digest} (${artifact.fileCount} files)`}\n`);
	}

	process.stdout.write(`workspaces ready at the pinned subject\n`);
};
