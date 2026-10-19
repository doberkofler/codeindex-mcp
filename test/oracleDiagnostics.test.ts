import {describe, expect, it} from 'vitest';
import {ORACLE_DIAGNOSTIC, OracleDiagnosticCollector} from '../src/adapters/oracle/diagnostics.ts';

describe('Oracle diagnostics', () => {
	it('bounds messages and records optional locations', () => {
		const collector = new OracleDiagnosticCollector('src/demo.pkb');

		collector.add(ORACLE_DIAGNOSTIC.parse, 'x'.repeat(400), 3, 7);
		collector.add(ORACLE_DIAGNOSTIC.lexer, 'missing location');

		expect(collector.finish()).toStrictEqual([
			{
				category: 'warning',
				code: ORACLE_DIAGNOSTIC.parse,
				message: 'x'.repeat(300),
				path: 'src/demo.pkb',
				startLine: 3,
				startColumn: 7,
			},
			{
				category: 'warning',
				code: ORACLE_DIAGNOSTIC.lexer,
				message: 'missing location',
				path: 'src/demo.pkb',
				startLine: null,
				startColumn: null,
			},
		]);
	});

	it('adds one overflow marker after twenty diagnostics', () => {
		const collector = new OracleDiagnosticCollector('src/demo.pkb');

		for (let index = 0; index < 20; index += 1) {
			collector.add(ORACLE_DIAGNOSTIC.malformedDeclaration, `diagnostic ${String(index)}`);
		}

		expect(collector.finish()).toHaveLength(20);

		collector.add(ORACLE_DIAGNOSTIC.malformedDeclaration, 'overflow');
		collector.add(ORACLE_DIAGNOSTIC.ambiguousOverload, 'overflow again');

		expect(collector.finish()).toHaveLength(21);
		expect(collector.finish().at(-1)).toMatchObject({
			code: ORACLE_DIAGNOSTIC.diagnosticOverflow,
			message: 'Additional Oracle diagnostics were suppressed for this file',
			startLine: null,
			startColumn: null,
		});
	});
});
