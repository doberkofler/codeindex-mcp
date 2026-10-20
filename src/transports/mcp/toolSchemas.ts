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
	query: z.string().describe('Exact qualified name, exact simple name, or name prefix; may be empty only with container'),
	match: z.enum(['name', 'qualified']).default('name').describe('Compare the simple name or full qualified display'),
	kind: z.string().max(MAX_SYMBOL_KIND_LENGTH).regex(SYMBOL_KIND_PATTERN).optional().describe('Optional adapter-defined symbol kind filter'),
	container: z.string().optional().describe('Binding container display prefix; empty query lists its members'),
	path: z.string().min(1).optional().describe('Only symbols with a definition occurrence in this path'),
	context: ContextSchema,
	exposure: z.enum(['published', 'reachable', 'visible', 'internal', 'any']).default('any').describe('Binding exposure filter'),
	limit: LimitSchema,
	cursor: CursorSchema,
});

export const FindReferencesInputSchema = z.object({
	symbolId: z.string().min(1).describe('Symbol identifier returned by find_symbol or outline'),
	role: z.enum(['definition', 'reference']).optional(),
	path: z.string().min(1).optional().describe('Only occurrences in this path'),
	enclosingId: z.string().min(1).optional().describe('Only occurrences owned by this symbol'),
	usage: z
		.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4), z.literal(6), z.literal(8)])
		.optional()
		.describe('Usage bitmask filter'),
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
	siteId: z.string().min(1).optional().describe('Optional definition site identifier from find_symbol or outline'),
	mode: z.enum(['text', 'sites', 'names', 'binding_sites', 'binding_contexts']).default('text').describe('Text extent or one bounded list mode'),
	bindingId: z.string().min(1).optional().describe('Required binding identifier for binding_sites and binding_contexts'),
	context: ContextSchema,
	contextLines: z.number().int().min(0).max(20).default(2).describe('Additional lines before and after the declaration'),
	limit: z.number().int().min(1).max(100).default(50),
	cursor: CursorSchema,
});

export const SymbolAtInputSchema = z.object({
	path: z.string().min(1).describe('Repository-relative POSIX path'),
	line: z.number().int().min(1).describe('One-based line number'),
	column: z.number().int().min(1).optional().describe('One-based column; omitted means the innermost extent covering the line'),
});
