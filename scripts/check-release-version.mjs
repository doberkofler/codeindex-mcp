import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';

const root = path.resolve(import.meta.dirname, '..');
const PackageManifestSchema = z.object({version: z.string().min(1)});
const manifest = PackageManifestSchema.parse(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')));
const expected = `codeindex-mcp ${manifest.version}`;

const result = spawnSync(process.execPath, [path.join(root, 'dist', 'mcp.mjs'), '--help'], {encoding: 'utf8'});
const banner = result.stderr.split('\n', 1)[0] ?? '';

if (result.status !== 0 || banner !== expected) {
	process.stderr.write(`Release artifact version mismatch: expected "${expected}", received "${banner}" (exit ${String(result.status)})\n`);
	process.exit(1);
}

process.stdout.write(`Release artifact reports ${banner}\n`);
