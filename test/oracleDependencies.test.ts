import {describe, expect, it} from 'vitest';
import {oracleDependentsOf, type OracleDependencyRowType} from '../src/core/qualification/oracle/live/oracleDependencies.ts';

const edge = (name: string, type: string, referencedName: string, referencedType: string): OracleDependencyRowType => ({
	name,
	type,
	referencedName,
	referencedType,
});

describe('Oracle dependent closure', () => {
	it('orders direct dependents before their transitive dependents', () => {
		const dependents = oracleDependentsOf(
			[{type: 'PACKAGE', name: 'HR_API'}],
			[edge('HR_VIEW_CHILD', 'VIEW', 'HR_VIEW', 'VIEW'), edge('HR_VIEW', 'VIEW', 'HR_API', 'PACKAGE'), edge('HR_TRIGGER', 'TRIGGER', 'HR_API', 'PACKAGE')],
		);

		expect(dependents.map((dependent) => dependent.name)).toStrictEqual(['HR_TRIGGER', 'HR_VIEW', 'HR_VIEW_CHILD']);
		expect(dependents.map((dependent) => dependent.depth)).toStrictEqual([1, 1, 2]);
	});

	it('excludes qualification targets and non-compilable object types', () => {
		const dependents = oracleDependentsOf(
			[
				{type: 'PACKAGE', name: 'HR_API'},
				{type: 'PACKAGE BODY', name: 'HR_API'},
			],
			[edge('HR_API', 'PACKAGE BODY', 'HR_API', 'PACKAGE'), edge('HR_TABLE', 'TABLE', 'HR_API', 'PACKAGE'), edge('HR_VIEW', 'VIEW', 'HR_API', 'PACKAGE')],
		);

		expect(dependents).toStrictEqual([{type: 'VIEW', name: 'HR_VIEW', compileClause: '', depth: 1}]);
	});

	it('assigns the compile clause for each supported dependent type', () => {
		const dependents = oracleDependentsOf(
			[{type: 'PROCEDURE', name: 'RUN_JOB'}],
			[
				edge('HR_TYPE', 'TYPE', 'RUN_JOB', 'PROCEDURE'),
				edge('HR_TYPE', 'TYPE BODY', 'HR_TYPE', 'TYPE'),
				edge('HR_PACKAGE', 'PACKAGE', 'RUN_JOB', 'PROCEDURE'),
				edge('HR_PACKAGE', 'PACKAGE BODY', 'HR_PACKAGE', 'PACKAGE'),
			],
		);
		const clauses = Object.fromEntries(dependents.map((dependent) => [`${dependent.type} ${dependent.name}`, dependent.compileClause]));

		expect(clauses).toStrictEqual({
			'PACKAGE HR_PACKAGE': 'SPECIFICATION',
			'PACKAGE BODY HR_PACKAGE': 'BODY',
			'TYPE HR_TYPE': 'SPECIFICATION',
			'TYPE BODY HR_TYPE': 'BODY',
		});
	});

	it('normalizes names, deduplicates edges, and terminates on cycles', () => {
		const dependents = oracleDependentsOf(
			[{type: 'package', name: 'hr_api'}],
			[edge('hr_view', 'view', 'HR_API', 'PACKAGE'), edge('HR_VIEW', 'VIEW', 'hr_api', 'package'), edge('HR_API', 'PACKAGE', 'HR_VIEW', 'VIEW')],
		);

		expect(dependents).toStrictEqual([{type: 'VIEW', name: 'HR_VIEW', compileClause: '', depth: 1}]);
	});

	it('keeps same-named objects of different types distinct', () => {
		const dependents = oracleDependentsOf(
			[{type: 'PACKAGE', name: 'HR_API'}],
			[edge('HR_ITEM', 'VIEW', 'HR_API', 'PACKAGE'), edge('HR_ITEM', 'SYNONYM', 'HR_API', 'PACKAGE')],
		);

		expect(dependents.map((dependent) => dependent.type)).toStrictEqual(['VIEW', 'SYNONYM']);
	});
});
