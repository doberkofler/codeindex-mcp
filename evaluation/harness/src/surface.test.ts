import assert from 'node:assert/strict';
import test from 'node:test';
import {assertPresentedSurface, callableToolsOf, effectivePermissionOf, permissionRulesOf, presentedToolsOf, surfaceDifferencesOf} from './surface.ts';
import {toolSurfaceOf, treatmentOf} from './treatment.ts';

const ORDINARY = ['bash', 'edit', 'glob', 'grep', 'list', 'read'];

const accepted = treatmentOf({
	id: 'accepted',
	kind: 'codeindex',
	ordinaryTools: ORDINARY,
	codeMode: 'absent',
	artifact: {id: 'accepted', root: 'artifacts/accepted', entryPoint: 'mcp.mjs'},
	mcp: {server: 'codeindex', codemode: false},
});

const surface = toolSurfaceOf(accepted, ['find_symbol', 'read_symbol']);

void test('a declared surface denies every action it does not name', () => {
	const rules = permissionRulesOf(surface);

	assert.deepEqual(rules[0], {action: '*', resource: '*', effect: 'deny'});
	assert.deepEqual(
		rules.slice(1).map((rule) => rule.action),
		['codeindex_find_symbol', 'codeindex_read_symbol', 'edit', 'glob', 'grep', 'list', 'read', 'shell'],
	);
	assert.equal(effectivePermissionOf(rules, 'shell'), 'allow');
	assert.equal(effectivePermissionOf(rules, 'edit'), 'allow');
	assert.equal(effectivePermissionOf(rules, 'codeindex_find_symbol'), 'allow');
	assert.equal(effectivePermissionOf(rules, 'webfetch'), 'deny');
	assert.equal(effectivePermissionOf(rules, 'codeindex_undeclared'), 'deny');
	assert.equal(effectivePermissionOf(rules, 'execute'), 'deny');
});

void test('the last matching rule wins over the built-in base policy', () => {
	const rules = [{action: '*', resource: '*', effect: 'allow'}, {action: 'read', resource: '*.env', effect: 'ask'}, ...permissionRulesOf(surface)] as const;

	assert.equal(effectivePermissionOf(rules, 'shell'), 'allow');
	assert.equal(effectivePermissionOf(rules, 'read', '.env'), 'allow');
	assert.equal(effectivePermissionOf(rules, 'websearch'), 'deny');
});

void test('callable names include every tool the edit and bash actions allow', () => {
	assert.deepEqual(callableToolsOf(['bash', 'edit', 'read']), ['bash', 'edit', 'patch', 'read', 'shell', 'write']);
});

void test('presented names drop retired tools and expand shared actions', () => {
	assert.deepEqual(presentedToolsOf(surface), ['codeindex_find_symbol', 'codeindex_read_symbol', 'edit', 'glob', 'grep', 'read', 'shell', 'write']);
});

void test('surface differences name every missing declared and extra observed tool', () => {
	const exact = presentedToolsOf(surface);

	assert.deepEqual(surfaceDifferencesOf(surface, exact), []);
	assert.match(
		surfaceDifferencesOf(
			surface,
			exact.filter((name) => name !== 'write'),
		).join('\n'),
		/declared tool write is not presented/u,
	);
	assert.match(
		surfaceDifferencesOf(
			surface,
			exact.filter((name) => name !== 'codeindex_read_symbol'),
		).join('\n'),
		/declared tool codeindex_read_symbol is not presented/u,
	);
	assert.match(surfaceDifferencesOf(surface, [...exact, 'webfetch']).join('\n'), /undeclared tool webfetch is presented/u);
	assert.match(surfaceDifferencesOf(surface, [...exact, 'execute']).join('\n'), /undeclared tool execute is presented/u);
});

void test('an exact capture is accepted and returned sorted', () => {
	const exact = [...presentedToolsOf(surface)].toReversed();

	assert.deepEqual(assertPresentedSurface(surface, exact), presentedToolsOf(surface));
	assert.throws(() => assertPresentedSurface(surface, exact.slice(1)), /does not present the declared accepted tool surface/u);
});
