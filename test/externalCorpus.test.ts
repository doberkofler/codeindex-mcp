import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {loadBenchmarkSuite} from '../src/core/benchmark/suiteTypes.ts';

const evaluationRoot = path.resolve(import.meta.dirname, '..', 'evaluation');
const corpusPath = path.join(evaluationRoot, 'corpora', 'external-material-ui.json');
const benchmarkPath = path.resolve(import.meta.dirname, '..', 'benchmark', 'suites', 'typescript-public.json');

const relativePath = z
	.string()
	.min(1)
	.refine((value) => !path.isAbsolute(value), 'must be repository-relative');

const corpusSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: z.literal('external-material-ui'),
		status: z.literal('selected'),
		role: z.literal('external-corpus'),
		repository: z.url(),
		revision: z.string().regex(/^[0-9a-f]{40}$/u),
		directory: relativePath,
		projectFile: relativePath,
		lockFile: relativePath,
		lockFileSha256: z.string().regex(/^[0-9a-f]{64}$/u),
		preparation: z.array(z.string().min(1)).min(1),
		privacyClass: z.literal('public'),
		sourceMayBeMutated: z.literal(false),
		truthAuthority: z
			.object({
				kind: z.literal('language-service'),
				reference: z.string().min(1),
			})
			.strict(),
		environment: z
			.object({
				node: z.string().min(1),
				typescript: z.string().min(1),
				codeIndex: z.string().min(1),
				harness: z.number().int().positive(),
			})
			.strict(),
		caseHashes: z.record(z.string(), z.string()),
		distinctEvidence: z.array(z.string().min(1)).min(1),
		limitations: z.array(z.string().min(1)).min(1),
	})
	.strict();

const corpusOf = (file: string): z.infer<typeof corpusSchema> => corpusSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

describe('external corpus manifest', () => {
	it('pins the selected corpus to the benchmark project identity', () => {
		const corpus = corpusOf(corpusPath);
		const suite = loadBenchmarkSuite(benchmarkPath);
		const project = suite.publicProjects.find((item) => item.name === 'material-ui');

		if (project === undefined) {
			throw new Error('the public benchmark suite must declare material-ui');
		}

		expect(corpus.repository).toBe(project.repository);
		expect(corpus.revision).toBe(project.revision);
		expect(corpus.directory).toBe(project.directory);
		expect(corpus.projectFile).toBe(project.projectFile);
		expect(corpus.caseHashes).toStrictEqual({});
	});

	it('records the selection and rejects an absolute checkout path', () => {
		const corpus = corpusOf(corpusPath);

		expect(corpus.status).toBe('selected');
		expect(corpus.distinctEvidence).toContain('tsx-components');
		const absolute = {...corpus, projectFile: '/Users/operator/material-ui/packages/mui-material/tsconfig.json'};

		expect(corpusSchema.safeParse(absolute).success).toBe(false);
	});
});
