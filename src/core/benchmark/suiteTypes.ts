import {readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';

const SCENARIO_NAMES = ['cold', 'warm', 'rebuild', 'edit', 'deep', 'queries'] as const;
const PROFILE_NAMES = ['small', 'medium', 'large', 'xl'] as const;

const ScenarioSchema = z.enum(SCENARIO_NAMES);
const ProfileSchema = z.enum(PROFILE_NAMES);

const GeneratedProfilesSchema = z
	.array(
		z
			.object({
				profile: ProfileSchema,
				runs: z.number().int().min(1).max(20).default(1),
				scenarios: z.array(ScenarioSchema).min(1).default(['cold', 'warm', 'rebuild', 'edit', 'deep', 'queries']),
				iterations: z.number().int().min(1).max(10_000).default(20),
				editRounds: z.number().int().min(1).max(1000).default(5),
				baseline: z.string().min(1).nullable().default(null),
				reference: z.enum(['first-run', 'none']).default('first-run'),
				coldProcess: z.boolean().default(false),
			})
			.superRefine((value, context) => {
				if (value.reference === 'first-run' && value.runs > 1 && value.baseline === null) {
					context.addIssue({
						code: 'custom',
						path: ['reference'],
						message: 'reference "first-run" requires a baseline for repeated runs',
					});
				}

				if (!value.coldProcess && !value.scenarios.includes('cold')) {
					context.addIssue({code: 'custom', path: ['scenarios'], message: 'cold is required when coldProcess is false'});
				}
			}),
	)
	.default([])
	.refine((entries) => new Set(entries.map((entry) => entry.profile)).size === entries.length, {
		message: 'generated profiles must be unique',
	});

const PublicProjectsSchema = z
	.array(
		z
			.object({
				name: z.string().regex(/^[a-z0-9-]+$/u, 'name must contain lowercase letters, digits, and dashes'),
				repository: z.string().min(1),
				revision: z.string().regex(/^[0-9a-f]{40}$/u, 'revision must be a full 40-character commit SHA'),
				directory: z.string().regex(/^[a-z0-9-]+$/u, 'directory must contain lowercase letters, digits, and dashes'),
				projectFile: z.string().min(1),
				scenarios: z.array(ScenarioSchema).min(1).default(['cold', 'warm', 'rebuild', 'deep', 'queries']),
				iterations: z.number().int().min(1).max(10_000).default(20),
				runs: z.number().int().min(1).max(20).default(1),
				baseline: z.string().min(1).nullable().default(null),
				reference: z.enum(['first-run', 'none']).default('none'),
			})
			.superRefine((value, context) => {
				if (value.scenarios.includes('edit')) {
					context.addIssue({code: 'custom', path: ['scenarios'], message: 'edit mutates source and is not allowed for public projects'});
				}

				if (!value.scenarios.includes('cold')) {
					context.addIssue({code: 'custom', path: ['scenarios'], message: 'cold is required for public projects'});
				}

				if (value.reference === 'first-run' && value.runs > 1 && value.baseline === null) {
					context.addIssue({code: 'custom', path: ['reference'], message: 'reference "first-run" requires a baseline for repeated runs'});
				}
			}),
	)
	.default([])
	.refine((entries) => new Set(entries.map((entry) => entry.name)).size === entries.length, {
		message: 'public project names must be unique',
	})
	.refine((entries) => new Set(entries.map((entry) => entry.directory)).size === entries.length, {
		message: 'public project directories must be unique',
	});

const ReferenceVerificationSchema = z.object({
	enabled: z.boolean().default(true),
	root: z.string().min(1).default('test/fixtures/reference-corpus'),
	projectFile: z.string().min(1).default('tsconfig.json'),
});

/**
 * Declarative qualification suite.
 *
 * Generated profiles are disposable corpora; public projects are pinned
 * checkouts prepared outside the measured interval. The suite contains no
 * machine-specific paths.
 */
export const BenchmarkSuiteSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: z.string().regex(/^[a-z0-9-]+$/u, 'id must contain lowercase letters, digits, and dashes'),
		description: z.string().min(1).optional(),
		projectsRoot: z.string().min(1).default('~/.cache/codeindex-benchmark/projects'),
		generated: GeneratedProfilesSchema,
		referenceVerification: ReferenceVerificationSchema.optional(),
		publicProjects: PublicProjectsSchema,
	})
	.superRefine((suite, context) => {
		if (suite.generated.length === 0 && suite.publicProjects.length === 0 && suite.referenceVerification?.enabled !== true) {
			context.addIssue({code: 'custom', path: ['generated'], message: 'suite contains no runnable steps'});
		}
	});

export type BenchmarkSuiteType = z.infer<typeof BenchmarkSuiteSchema>;
export type BenchmarkSuiteGeneratedType = BenchmarkSuiteType['generated'][number];
export type BenchmarkSuitePublicProjectType = BenchmarkSuiteType['publicProjects'][number];

/**
 * Expands a leading `~` to the current user's home directory.
 *
 * @param value - Configured path.
 * @param home - Home directory used for expansion.
 * @returns The original path or a home-relative path.
 */
export const expandHome = (value: string, home: string): string => (value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value);

/**
 * Loads and validates a benchmark suite.
 *
 * @param filePath - Suite JSON file.
 * @returns Parsed suite with defaults applied.
 * @throws {@link Error} When the file is unreadable or invalid.
 */
export const loadBenchmarkSuite = (filePath: string): BenchmarkSuiteType => {
	const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
	const result = BenchmarkSuiteSchema.safeParse(parsed);

	if (!result.success) {
		throw new Error(`Invalid benchmark suite ${filePath}:\n${z.prettifyError(result.error)}`, {cause: result.error});
	}

	return result.data;
};

/**
 * Resolves the public-project root.
 *
 * @param suite - Parsed suite.
 * @param override - Command-line override, when supplied.
 * @param home - Current user's home directory.
 * @param cwd - Base directory for relative override paths.
 * @returns Absolute projects root.
 */
export const resolveProjectsRoot = (suite: BenchmarkSuiteType, override: string | undefined, home: string, cwd: string): string =>
	path.resolve(cwd, expandHome(override ?? suite.projectsRoot, home));
