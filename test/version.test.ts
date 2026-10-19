import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {describe, expect, it} from 'vitest';
import {PROGRAM_VERSION} from '../src/core/version.ts';

const PackageManifestSchema = z.object({version: z.string().min(1)});

describe('program version', () => {
	it('matches the package manifest version', () => {
		const manifest = PackageManifestSchema.parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

		expect(PROGRAM_VERSION).toBe(manifest.version);
	});
});
