import {once} from 'node:events';
import {describe, expect, it} from 'vitest';
import {RefreshCoordinator} from '../src/core/freshness/refreshCoordinator.ts';
import {type BuildReportType} from '../src/core/model.ts';
import {silentLogger} from './helpers/fixture.ts';
import {createRefreshClock, flushRefresh, ORACLE_ADAPTER, refreshReport, type RefreshCallType, TYPESCRIPT_ADAPTER} from './helpers/refreshCoordinator.ts';

describe('RefreshCoordinator manual requests during scoped work', () => {
	it('does not satisfy an ordinary full request with scoped work', async () => {
		const {clock, advance} = createRefreshClock();
		const gate = new EventTarget();
		const calls: RefreshCallType[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [ORACLE_ADAPTER, TYPESCRIPT_ADAPTER],
			initiallyCurrent: true,
			runRefresh: async (reason, adapterIds, force, signal): Promise<BuildReportType> => {
				calls.push({reason, adapterIds, force, signal, at: 0});

				if (calls.length === 1) {
					await once(gate, 'release');
				}

				return refreshReport(calls.length);
			},
			logger: silentLogger,
			clock,
		});

		coordinator.request({kind: 'change', paths: ['src/a.ts'], adapterIds: ['typescript']});
		await advance(500);
		const manual = coordinator.request({kind: 'manual', force: false});
		gate.dispatchEvent(new Event('release'));
		await flushRefresh();
		const manualReport = await manual;

		expect(manualReport.revision).toBe(2);
		expect(calls.map((call) => call.adapterIds)).toStrictEqual([['typescript'], null]);
		await coordinator.close();
	});
});

describe('RefreshCoordinator manual force strength', () => {
	it('does not satisfy a forced request with an ordinary full attempt', async () => {
		const {clock} = createRefreshClock();
		const gate = new EventTarget();
		const calls: RefreshCallType[] = [];
		const coordinator = new RefreshCoordinator({
			adapters: [ORACLE_ADAPTER, TYPESCRIPT_ADAPTER],
			initiallyCurrent: true,
			runRefresh: async (reason, adapterIds, force, signal): Promise<BuildReportType> => {
				calls.push({reason, adapterIds, force, signal, at: 0});

				if (calls.length === 1) {
					await once(gate, 'release');
				}

				return refreshReport(calls.length);
			},
			logger: silentLogger,
			clock,
		});

		const ordinary = coordinator.request({kind: 'manual', force: false});
		const forced = coordinator.request({kind: 'manual', force: true});
		gate.dispatchEvent(new Event('release'));
		await flushRefresh();
		const ordinaryReport = await ordinary;
		const forcedReport = await forced;

		expect(ordinaryReport.revision).toBe(1);
		expect(forcedReport.revision).toBe(2);
		expect(calls.map((call) => call.force)).toStrictEqual([false, true]);
		await coordinator.close();
	});

	it('joins an active forced full attempt when it is strong enough', async () => {
		const {clock} = createRefreshClock();
		const gate = new EventTarget();
		let calls = 0;
		const coordinator = new RefreshCoordinator({
			adapters: [ORACLE_ADAPTER, TYPESCRIPT_ADAPTER],
			initiallyCurrent: true,
			runRefresh: async (): Promise<BuildReportType> => {
				calls += 1;
				await once(gate, 'release');
				return refreshReport(calls);
			},
			logger: silentLogger,
			clock,
		});

		const forced = coordinator.request({kind: 'manual', force: true});
		const ordinary = coordinator.request({kind: 'manual', force: false});
		gate.dispatchEvent(new Event('release'));
		const forcedReport = await forced;
		const ordinaryReport = await ordinary;

		expect(forcedReport.revision).toBe(1);
		expect(ordinaryReport.revision).toBe(1);
		expect(calls).toBe(1);
		await coordinator.close();
	});
});
