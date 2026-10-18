import {spawnSync} from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * @param {readonly string[]} [args] - Extra Vite arguments.
 * @param {Record<string, string>} [environment] - Extra environment variables.
 */
const build = (args = [], environment = {}) => {
	/** @type {string[]} */
	const command = [vite, 'build'];
	for (const argument of args) {
		command.push(argument);
	}

	const result = spawnSync(process.execPath, command, {
		cwd: root,
		env: {...process.env, ...environment},
		stdio: 'inherit',
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
};

build([], {CODE_INDEX_ENTRY: 'mcp'});
build([], {CODE_INDEX_ENTRY: 'cli'});
build([], {CODE_INDEX_ENTRY: 'console'});
build(['--config', 'vite.console.config.ts']);
