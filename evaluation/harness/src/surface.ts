import {type ToolSurfaceType} from './treatment.ts';

/** One ordered OpenCode permission rule. */
export type PermissionEffectType = 'allow' | 'deny' | 'ask';

export type PermissionRuleType = Readonly<{
	action: string;
	resource: string;
	effect: PermissionEffectType;
}>;

/**
 * Maps a declared tool name to the OpenCode permission action it consults.
 *
 * OpenCode 2 names the shell and subagent actions `shell` and `subagent`,
 * while the model-facing tools are `bash` and `task`. Editing is one action
 * for `edit`, `write`, and `patch`. Every other declared name is its action.
 */
export const OPEN_CODE_TOOL_ACTIONS: Readonly<Record<string, string>> = {
	bash: 'shell',
	patch: 'edit',
	task: 'subagent',
	write: 'edit',
};

/**
 * Ordinary tools OpenCode 2 no longer presents.
 *
 * `list` was a version-1 tool; `read` lists directories now. Suites keep it
 * declared so their frozen definitions stay valid, but no run can present or
 * call it.
 */
export const RETIRED_TOOLS = ['list'] as const;

/**
 * OpenCode tool names a declared ordinary tool makes callable.
 *
 * The first name is the canonical harness name; the rest are names OpenCode may
 * emit for the same permission action. `write` and `patch` share the `edit`
 * permission, and `shell` is emitted for the declared `bash` tool.
 */
export const CALLABLE_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
	bash: ['bash', 'shell'],
	edit: ['edit', 'write', 'patch'],
};

/**
 * OpenCode tool names a declared ordinary tool presents to the model.
 *
 * `patch` is offered only to models that advertise patch support, so it is
 * callable but not part of the expected surface.
 */
export const PRESENTED_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
	bash: ['shell'],
	edit: ['edit', 'write'],
};

/**
 * Returns the permission action for one model-facing tool name.
 *
 * @param tool - Declared ordinary tool or native MCP tool name.
 * @returns The action OpenCode checks for that tool.
 */
export const permissionActionOf = (tool: string): string => OPEN_CODE_TOOL_ACTIONS[tool] ?? tool;

const wildcardPatternOf = (pattern: string): RegExp =>
	new RegExp(
		`^${pattern
			.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
			.replaceAll(String.raw`\*`, '.*')
			.replaceAll(String.raw`\?`, '.')}$`,
		'u',
	);

const matchesRule = (rule: PermissionRuleType, action: string, resource: string): boolean =>
	wildcardPatternOf(rule.action).test(action) && wildcardPatternOf(rule.resource).test(resource);

/**
 * Builds the exact ordered permission set for one declared tool surface.
 *
 * A leading deny-all rule removes every built-in and dynamically registered
 * tool that the surface does not declare. The following allow rules name each
 * declared ordinary and MCP tool exactly; OpenCode applies the last matching
 * rule, so the declared tools are the only permitted actions.
 *
 * @param surface - Exact tool names presented for one treatment.
 * @returns Ordered permission rules written into the treatment configuration.
 */
export const permissionRulesOf = (surface: Pick<ToolSurfaceType, 'tools'> & Partial<Pick<ToolSurfaceType, 'permitted'>>): readonly PermissionRuleType[] => [
	{action: '*', resource: '*', effect: 'deny'},
	...[...new Set((surface.permitted ?? surface.tools).map((tool) => permissionActionOf(tool)))]
		.sort()
		.map((action) => ({action, resource: '*', effect: 'allow' as const})),
];

/**
 * Resolves the last matching permission rule.
 *
 * OpenCode applies the last matching rule and uses `ask` when no rule matches.
 *
 * @param rules - Ordered permission rules.
 * @param action - Permission action to resolve.
 * @param resource - Resource to resolve; the evaluation surface uses `*`.
 * @returns The effective effect.
 */
export const effectivePermissionOf = (rules: readonly PermissionRuleType[], action: string, resource = '*'): PermissionEffectType => {
	let effect: PermissionEffectType = 'ask';

	for (const rule of rules) {
		if (matchesRule(rule, action, resource)) {
			({effect} = rule);
		}
	}

	return effect;
};

/**
 * Expands declared ordinary tool names into every callable name.
 *
 * @param declared - Ordinary tool names declared by a treatment.
 * @returns Sorted unique callable names.
 */
export const callableToolsOf = (declared: readonly string[]): readonly string[] =>
	[...new Set(declared.flatMap((name) => CALLABLE_TOOL_ALIASES[name] ?? [name]))].sort();

/**
 * Lists the exact tool names OpenCode 2 must present for one surface.
 *
 * @param surface - Captured surface.
 * @returns Sorted unique presented names, excluding retired tools.
 */
export const presentedToolsOf = (surface: Pick<ToolSurfaceType, 'ordinary' | 'codeIndex' | 'execute'>): readonly string[] =>
	[
		...new Set([
			...surface.ordinary.filter((name) => !(RETIRED_TOOLS as readonly string[]).includes(name)).flatMap((name) => PRESENTED_TOOL_ALIASES[name] ?? [name]),
			...(surface.execute === 'present' ? ['execute'] : surface.codeIndex),
		]),
	].sort();

/**
 * Removes the OpenCode server prefix from the captured CodeIndex names.
 *
 * @param surface - Captured surface.
 * @param server - Configured MCP server name.
 * @returns Sorted native catalog names the artifact itself must present.
 */
export const nativeCatalogToolsOf = (surface: Pick<ToolSurfaceType, 'codeIndex'>, server: string): readonly string[] => {
	const prefix = `${server}_`;

	return surface.codeIndex.map((name) => {
		if (!name.startsWith(prefix)) {
			throw new Error(`captured CodeIndex tool ${name} does not carry the ${prefix} prefix`);
		}

		return name.slice(prefix.length);
	});
};

/**
 * Lists every difference between the declared surface and the tools a
 * model-free probe observed being sent to the provider.
 *
 * @param surface - Exact declared surface.
 * @param observed - Tool names captured from the provider request.
 * @returns Human-readable differences; empty when the surface is exact.
 */
export const surfaceDifferencesOf = (surface: ToolSurfaceType, observed: readonly string[]): readonly string[] => {
	const expected = new Set(presentedToolsOf(surface));
	const seen = new Set(observed);
	const differences = [...expected].filter((name) => !seen.has(name)).map((name) => `declared tool ${name} is not presented`);
	const unexpected = [...seen].filter((name) => !expected.has(name)).map((name) => `undeclared tool ${name} is presented`);

	return [...differences, ...unexpected].sort();
};

/**
 * Requires the presented tool list to equal the declared surface exactly.
 *
 * @param surface - Exact declared surface.
 * @param observed - Tool names captured from the provider request.
 * @returns The observed names when they match.
 */
export const assertPresentedSurface = (surface: ToolSurfaceType, observed: readonly string[]): readonly string[] => {
	const differences = surfaceDifferencesOf(surface, observed);

	if (differences.length > 0) {
		throw new Error(`OpenCode does not present the declared ${surface.treatmentId} tool surface: ${differences.join('; ')}`);
	}

	return [...observed].sort();
};
