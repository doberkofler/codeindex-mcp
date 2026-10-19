import {z} from 'zod';

const SYMBOL_KIND_PATTERN = /^[a-z][a-z0-9_]*$/u;
const MAX_SYMBOL_KIND_LENGTH = 64;
const MAX_SYMBOL_KIND_FILTERS = 32;

const LimitSchema = z.number().int().min(1).max(100).default(50);
// Compact dependency items are long enough that 50 exceed the 4 KiB page target.
const DependencyLimitSchema = z.number().int().min(1).max(100).default(25);
const CursorSchema = z.string().min(1).optional();

export const IndexStatusInputSchema = z.object({});

export const OutlineInputSchema = z.object({
	path: z.string().min(1).describe('Repository-relative POSIX path, for example src/data/user/index.ts'),
	kinds: z
		.array(z.string().max(MAX_SYMBOL_KIND_LENGTH).regex(SYMBOL_KIND_PATTERN))
		.max(MAX_SYMBOL_KIND_FILTERS)
		.optional()
		.describe('Optional adapter-defined symbol-kind filter'),
	limit: LimitSchema,
	cursor: CursorSchema,
});

const ContextSchema = z.string().min(1).optional().describe('Optional project context name from index_status.scope.projects');

export const FindSymbolInputSchema = z.object({
	query: z.string().min(1).describe('Exact qualified name, exact simple name, or name prefix'),
	context: ContextSchema,
	limit: LimitSchema,
	cursor: CursorSchema,
});

export const FindReferencesInputSchema = z.object({
	symbolId: z.string().min(1).describe('Symbol identifier returned by find_symbol or outline'),
	role: z.enum(['definition', 'reference']).optional(),
	context: ContextSchema,
	limit: LimitSchema,
	cursor: CursorSchema,
});

export const FindDependenciesInputSchema = z.object({
	target: z.string().min(1).describe('Canonical target identifier, for example lodash, @mui/material, or SCHEMA.PACKAGE'),
	context: ContextSchema,
	direction: z.literal('consumers').default('consumers').describe('Dependency direction; consumers is the only supported direction'),
	transitive: z
		.boolean()
		.default(false)
		.describe('false (default) returns direct target usage; true returns dependency impact through authored module targets'),
	root: z.string().min(1).optional().describe('Direct target consumer used to filter dependency impact; requires transitive: true'),
	detail: z
		.enum(['compact', 'evidence'])
		.default('compact')
		.describe('compact (default) returns path, depth, and directRoot; evidence adds locations and bindings'),
	limit: DependencyLimitSchema,
	cursor: CursorSchema,
});

export const ReadSymbolInputSchema = z.object({
	symbolId: z.string().min(1).describe('Symbol identifier returned by find_symbol or outline'),
	contextLines: z.number().int().min(0).max(20).default(2).describe('Additional lines before and after the declaration'),
});
