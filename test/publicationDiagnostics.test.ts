import {describe, expect, it} from 'vitest';
import {createPublicationDiagnostics} from '../src/core/qualification/publication/diagnostics.ts';
import {type PublicationViolationExampleType} from '../src/core/qualification/publication/invariants.ts';
import {type R2ReportType, type ViolationSummaryType} from '../src/core/qualification/publication/types.ts';

const summaryOf = (
	classes: Readonly<Record<string, number>> = {},
	violations = Object.values(classes).reduce((total, count) => total + count, 0),
): ViolationSummaryType => ({
	status: 'measured',
	checked: 100,
	violations,
	classes,
});

const r2Of = (
	input: Readonly<{
		s3?: Readonly<Record<string, number>>;
		o2?: Readonly<Record<string, number>>;
		l1?: Readonly<Record<string, number>>;
		f1?: Readonly<Record<string, number>>;
	}> = {},
): R2ReportType => ({
	status: 'measured',
	s3: summaryOf(input.s3),
	o2: summaryOf(input.o2),
	l1: summaryOf(input.l1),
	f1: summaryOf(input.f1),
});

const exampleOf = (invariant: PublicationViolationExampleType['invariant'], className: string, index: number): PublicationViolationExampleType => ({
	invariant,
	class: className,
	path: `src/example-${String(index)}.ts`,
	startOffset: index,
	symbolId: `symbol-${String(index)}`,
	bindingId: index % 2 === 0 ? null : `binding-${String(index)}`,
});

describe('publication diagnostics artifact', () => {
	it('preserves identity and the incoming truncation state for an empty R2 report', () => {
		const artifact = createPublicationDiagnostics({
			projectId: 'project',
			contexts: ['root'],
			r2: r2Of(),
			examples: [],
			truncated: true,
		});

		expect(artifact).toStrictEqual({
			schemaVersion: 1,
			projectId: 'project',
			contexts: ['root'],
			groups: [],
			truncated: true,
		});
	});

	it('keeps one group complete when examples match the reported count', () => {
		const examples = [exampleOf('S3', 'missing-binding', 0), exampleOf('S3', 'missing-binding', 1)];
		const artifact = createPublicationDiagnostics({
			projectId: 'project',
			contexts: ['root'],
			r2: r2Of({s3: {'missing-binding': 2}}),
			examples,
			truncated: false,
		});

		expect(artifact.groups).toStrictEqual([{invariant: 'S3', class: 'missing-binding', examples, count: 2}]);
		expect(artifact.truncated).toBe(false);
	});

	it('marks the artifact truncated when a class has fewer examples than its count', () => {
		const examples = [exampleOf('O2', 'external-alias', 0)];
		const artifact = createPublicationDiagnostics({
			projectId: 'project',
			contexts: ['root'],
			r2: r2Of({o2: {'external-alias': 5}}),
			examples,
			truncated: false,
		});

		expect(artifact.groups).toStrictEqual([{invariant: 'O2', class: 'external-alias', examples, count: 5}]);
		expect(artifact.truncated).toBe(true);
	});
});

describe('publication diagnostics grouping', () => {
	it('retains at most twenty examples without changing the reported count', () => {
		const examples = Array.from({length: 25}, (_value, index) => exampleOf('L1', 'ambiguous-root', index));
		const artifact = createPublicationDiagnostics({
			projectId: 'project',
			contexts: ['root'],
			r2: r2Of({l1: {'ambiguous-root': 25}}),
			examples,
			truncated: false,
		});

		expect(artifact.groups).toStrictEqual([{invariant: 'L1', class: 'ambiguous-root', examples: examples.slice(0, 20), count: 25}]);
		expect(artifact.truncated).toBe(false);
	});

	it('groups by invariant order, then class insertion order, without leaking examples', () => {
		const examples = [
			exampleOf('F1', 'second', 0),
			exampleOf('L1', 'first', 1),
			exampleOf('S3', 'alpha', 2),
			exampleOf('S3', 'beta', 3),
			exampleOf('O2', 'only', 4),
			exampleOf('F1', 'first', 5),
		];
		const artifact = createPublicationDiagnostics({
			projectId: 'project',
			contexts: ['root', 'second'],
			r2: r2Of({
				f1: {second: 1, first: 1},
				l1: {first: 1},
				s3: {beta: 1, alpha: 1},
				o2: {only: 1},
			}),
			examples,
			truncated: false,
		});

		expect(artifact.groups.map((group) => `${group.invariant}:${group.class}`)).toStrictEqual([
			'S3:beta',
			'S3:alpha',
			'O2:only',
			'L1:first',
			'F1:second',
			'F1:first',
		]);
		const labels: string[] = [];

		for (const group of artifact.groups) {
			for (const example of group.examples) {
				labels.push(`${group.invariant}:${example.class}`);
			}
		}

		expect(labels).toStrictEqual(['S3:beta', 'S3:alpha', 'O2:only', 'L1:first', 'F1:second', 'F1:first']);
		expect(artifact.contexts).toStrictEqual(['root', 'second']);
	});

	it('contains no source text, query text, credentials, or absolute paths', () => {
		const artifact = createPublicationDiagnostics({
			projectId: 'project',
			contexts: ['root'],
			r2: r2Of({f1: {missing: 1}}),
			examples: [exampleOf('F1', 'missing', 0)],
			truncated: false,
		});
		const serialized = JSON.stringify(artifact);

		expect(serialized).not.toMatch(/(?:token|password|secret|api[_-]?key)/iu);
		expect(serialized).not.toContain('select ');
		expect(serialized).not.toContain('const ');
		for (const group of artifact.groups) {
			for (const example of group.examples) {
				expect(example.path.startsWith('/')).toBe(false);
				expect(example.path).not.toContain('..');
			}
		}
	});
});
