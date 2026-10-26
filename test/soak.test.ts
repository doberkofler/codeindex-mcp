import {afterEach, describe, expect, it} from 'vitest';
import {BUILD_FAILURE_CAUSES, buildFailureCauseOf, isBuildFailureCause} from '../src/core/generation/buildFailureCause.ts';
import {removeSoakWorkspace, runSoak} from '../src/core/benchmark/soakScenario.ts';
import {durationGate, IDLE_CPU_BUDGET_PERCENT, idleGate} from '../src/core/benchmark/soakGates.ts';
import {soakMarkdown} from '../src/core/benchmark/soakReport.ts';
import {type SoakIdleType, type SoakPlanType} from '../src/core/benchmark/soakTypes.ts';
import {createFixtureConfig, silentLogger} from './helpers/fixture.ts';

const idle = (averagePercent: number, medianPercent: number): SoakIdleType => ({
	windowMs: 10_000,
	cpuUserMs: 0,
	cpuSystemMs: 0,
	averagePercent,
	medianPercent,
	samplesPercent: [medianPercent],
});

const PLAN: SoakPlanType = {
	profile: 'small',
	rounds: 2,
	burstEdits: 2,
	failures: 1,
	restarts: 1,
	debounceMs: 20,
	timeoutMs: 30_000,
	durationMs: 0,
	idleSampleMs: 0,
};

describe('build failure causes', () => {
	it('classifies every supported failure into the closed set', () => {
		expect(buildFailureCauseOf(Object.assign(new Error('EISDIR: illegal operation on a directory, read'), {code: 'EISDIR'}))).toBe('source-read');
		expect(buildFailureCauseOf(new Error('Source changed during index build: src/a.ts'))).toBe('source-changed');
		expect(buildFailureCauseOf(new Error('Build lease was lost or taken over before publication'))).toBe('lease');
		expect(buildFailureCauseOf(new Error('SQLite integrity check failed'))).toBe('verification');
		expect(buildFailureCauseOf(new Error('disk I/O error'))).toBe('persistence');
		expect(buildFailureCauseOf(new Error('unrecognised failure'))).toBe('unknown');
		expect(BUILD_FAILURE_CAUSES.every((cause) => isBuildFailureCause(cause))).toBe(true);
		expect(isBuildFailureCause('not-a-cause')).toBe(false);
	});
});

describe('operational soak gates', () => {
	it('fails a declared duration that was not measured and accepts a completed one', () => {
		expect(durationGate(14_400_000, 14_400_000).result).toBe('pass');
		expect(durationGate(14_399_999, 14_400_000).result).toBe('fail');
		expect(durationGate(10, 0).result).toBe('pass');
	});

	it('gates idle CPU against the declared budget and states a skipped measurement', () => {
		expect(idleGate(idle(0.4, 0.4)).result).toBe('pass');
		expect(idleGate(idle(2, 2)).result).toBe('fail');
		expect(idleGate(idle(IDLE_CPU_BUDGET_PERCENT, IDLE_CPU_BUDGET_PERCENT)).result).toBe('fail');
		// A settling spike raises the mean but not the steady median.
		expect(idleGate(idle(1.4, 0.2)).result).toBe('pass');
		// A periodic burn that leaves most buckets quiet still fails the mean guard.
		expect(idleGate(idle(IDLE_CPU_BUDGET_PERCENT * 3, 0.2)).result).toBe('fail');
		expect(idleGate(null)).toStrictEqual({id: 'soak.idle-cpu', result: 'pass', detail: 'idle sampling not requested'});
	});
});

describe('operational soak', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	it('edits real files, recovers without intervention, restarts, and bounds retention', async () => {
		const fixture = createFixtureConfig('simple-project');
		const run = await runSoak({
			config: fixture.config,
			profile: PLAN.profile,
			plan: PLAN,
			logger: silentLogger,
			requireBuildOverlap: false,
		});
		cleanup = (): void => {
			removeSoakWorkspace(run);
			fixture.cleanup();
		};

		const {report} = run;

		expect(report.recordType).toBe('operational-soak');
		expect(report.planHash).toMatch(/^[a-f\d]{64}$/u);
		expect(report.editScriptHash).toMatch(/^[a-f\d]{64}$/u);
		expect(report.idle).toBeNull();
		expect(report.gates.map((gate) => gate.id)).toContain('soak.duration-completed');
		expect(report.gates.map((gate) => gate.id)).toContain('soak.idle-cpu');
		expect(report.events).toHaveLength(PLAN.rounds + 2);
		expect(report.events.flatMap((event) => event.edits).every((edit) => edit.contentChanged)).toBe(true);
		expect(report.staleRefusal).toMatchObject({refused: true, errorCode: 'stale_file', contentChanged: true});
		expect(report.failures).toHaveLength(1);
		expect(report.failureCauses).toStrictEqual({'source-read': 1});
		expect(report.recovery).toStrictEqual({injectedFailures: 1, recoveredFailures: 1, manualInterventions: 0, automatic: true});
		expect(report.restarts).toHaveLength(1);
		expect(report.restarts[0]).toMatchObject({reused: true, sameGeneration: true});
		expect(report.retention.satisfied).toBe(true);
		expect(report.retention.maxima.generations).toBeLessThanOrEqual(2);
		expect(report.passed).toBe(true);
		expect(report.blocking).toStrictEqual([]);
		expect(report.gates.every((gate) => gate.result === 'pass')).toBe(true);
		expect(report.latency.count).toBe(report.events.length);
		expect(soakMarkdown(report)).toContain('Operational soak report');
		expect(soakMarkdown(report)).not.toContain(run.workspace);
	}, 120_000);
});
