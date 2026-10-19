import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {type VcsProvenanceType} from '../../core/model.ts';

const VCS_TIMEOUT_MS = 3000;
const NONE: VcsProvenanceType = {kind: 'none', repository: null, revision: null, relativeRoot: null};

const run = (command: string, args: readonly string[], cwd: string): string | null => {
	try {
		const output = execFileSync(command, args, {
			cwd,
			encoding: 'utf8',
			timeout: VCS_TIMEOUT_MS,
			maxBuffer: 4 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		return output.length === 0 ? null : output;
	} catch {
		return null;
	}
};

const decodeXml = (value: string): string =>
	value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

const tagValue = (xml: string, tag: string): string | null => {
	const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'u').exec(xml);
	return match?.[1] === undefined ? null : decodeXml(match[1]);
};

const gitProvenance = (rootDir: string): VcsProvenanceType | null => {
	const topLevel = run('git', ['rev-parse', '--show-toplevel'], rootDir);

	if (topLevel === null) {
		return null;
	}

	const revision = run('git', ['rev-parse', 'HEAD'], rootDir);
	// A local checkout path is neither portable nor safe to persist; only a
	// configured remote identifies the repository.
	const repository = run('git', ['config', '--get', 'remote.origin.url'], rootDir);
	const relativeRoot = path.relative(realpathSync(topLevel), realpathSync(rootDir)).split(path.sep).join('/') || '.';

	return {kind: 'git', repository, revision, relativeRoot};
};

const svnProvenance = (rootDir: string): VcsProvenanceType | null => {
	const xml = run('svn', ['info', '--xml', rootDir], rootDir);

	if (xml === null) {
		return null;
	}

	const revision = run('svn', ['info', '--show-item', 'revision', rootDir], rootDir);

	return {
		kind: 'svn',
		repository: tagValue(xml, 'root'),
		revision,
		relativeRoot: tagValue(xml, 'relative-url'),
	};
};

/**
 * Reads version-control provenance for one workspace.
 *
 * Git and SVN are both optional: an unversioned directory, a missing binary, or
 * a command failure yields `kind: 'none'`. Provenance never blocks indexing and
 * this function never throws.
 *
 * @param rootDir - Absolute workspace root.
 * @returns Detected provenance, or the explicit `none` value.
 */
export const readVcsProvenance = (rootDir: string): VcsProvenanceType => gitProvenance(rootDir) ?? svnProvenance(rootDir) ?? NONE;
