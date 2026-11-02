import path from 'node:path';
import {runVerification} from '../src/adapters/typescript/verifyReferences.ts';

const fixtureRoot = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'reference-corpus');
const requestedRoot =
	process.argv.at(2) ?? (process.env['CODE_INDEX_ROOT'] === undefined && process.env['CODE_INDEX_CONFIG'] === undefined ? fixtureRoot : undefined);
const environment: NodeJS.ProcessEnv =
	requestedRoot === undefined
		? process.env
		: {
				...process.env,
				CODE_INDEX_ROOT: path.resolve(requestedRoot),
				CODE_INDEX_PROJECT_FILE: path.resolve(requestedRoot, 'tsconfig.json'),
			};

process.exitCode = runVerification(environment, {
	stdout: (line) => {
		process.stdout.write(`${line}\n`);
	},
});
