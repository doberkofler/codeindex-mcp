import {z} from 'zod';

const SYMBOL_KINDS = ['function', 'class', 'interface', 'type', 'enum', 'enum_member', 'namespace', 'method', 'property', 'accessor', 'variable'] as const;

const LimitSchema = z.number().int().min(1).max(100).default(50);
// Compact dependency items are long enough that 50 exceed the 4 KiB page target.
const DependencyLimitSchema = z.number().int().min(1).max(100).default(25);
const CursorSchema = z.string().min(1).optional();

export const IndexStatusInputSchema = z.object({});

export const OutlineInputSchema = z.object({
	path: z.string().min(1).describe('Repository-relative POSIX path, for example src/data/user/index.ts'),
	kinds: z.array(z.enum(SYMBOL_KINDS)).max(SYMBOL_KINDS.length).optional().describe('Optional symbol-kind filter'),
	limit: LimitSchema,
	cursor: CursorSchema,
});

export const FindSymbolInputSchema = z.object({
	query: z.string().min(1).describe('Exact qualified name, exact simple name, or name prefix'),
	limit: LimitSchema,
	cursor: CursorSchema,
});

export const FindReferencesInputSchema = z.object({
	symbolId: z.string().min(1).describe('Symbol identifier returned by find_symbol or outline'),
	role: z.enum(['definition', 'reference']).optional(),
	limit: LimitSchema,
	cursor: CursorSchema,
});

export const FindDependenciesInputSchema = z.object({
	package: z.string().min(1).describe('Normalized npm package name, for example lodash or @mui/material'),
	direction: z.literal('consumers').default('consumers').describe('Dependency direction; consumers is the only supported direction'),
	transitive: z.boolean().default(false).describe('false (default) returns direct package usage; true returns module impact through authored imports'),
	root: z.string().min(1).optional().describe('Direct package consumer used to filter module impact; requires transitive: true'),
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
