#!/usr/bin/env node
/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- NOTE: untyped Node tooling script; inputs are literal argument arrays. */
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'release-artifacts');
rmSync(output, {recursive: true, force: true});
mkdirSync(output, {recursive: true});

const run = (command, args) => {
	const result = spawnSync(command, args, {cwd: root, stdio: 'inherit'});

	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed`);
	}
};

run('pnpm', ['run', 'build:packages']);
run('pnpm', ['run', 'build']);

for (const filter of ['@codeindex/adapter-sdk', '@codeindex/adapter-typescript', '@codeindex/adapter-oracle', 'codeindex-mcp']) {
	run('pnpm', ['--filter', filter, 'pack', '--pack-destination', output]);
}

const manifestOf = (packageDirectory) => {
	const manifest = JSON.parse(readFileSync(path.join(root, packageDirectory, 'package.json'), 'utf8'));

	if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string') {
		throw new TypeError(`${packageDirectory} has no string name and version`);
	}

	return {name: manifest.name, version: manifest.version};
};

// Derive every artifact name from the packed manifest so a version bump cannot
// leave the release expecting a previous release's tarball.
const expected = ['packages/adapter-sdk', 'packages/adapter-typescript', 'packages/adapter-oracle', '.'].map((packageDirectory) => {
	const {name, version} = manifestOf(packageDirectory);

	return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
});

for (const name of expected) {
	readFileSync(path.join(output, name));
}

process.stdout.write(`${expected.join('\n')}\n`);
