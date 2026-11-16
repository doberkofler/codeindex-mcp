import {type AdapterWatchPlanType} from '@codeindex/adapter-sdk';

import {type LoggerType} from '../logging/logger.ts';
import {WorkspaceWatcher} from './workspaceWatcher.ts';

type AdapterWatchControllerOptionsType = Readonly<{
	readonly enabled: boolean;
	readonly rootDir: string;
	readonly logger: LoggerType;
	readonly plans: readonly AdapterWatchPlanType[];
	readonly onChange: (paths: readonly string[] | null, adapterIds: readonly string[]) => void;
	readonly onHandoff: () => void;
}>;

const plansChanged = (current: readonly AdapterWatchPlanType[], next: readonly AdapterWatchPlanType[]): boolean => {
	const identities = new Map(current.map((plan) => [plan.adapterId, plan.planId]));
	return next.length !== current.length || next.some((plan) => identities.get(plan.adapterId) !== plan.planId);
};

/**
 * Owns logical watch-plan installation over one deduplicated physical watcher.
 *
 * Every changed handoff schedules one authoritative reconciliation after the
 * new subscriptions are installed, covering events from the replacement window.
 */
export class AdapterWatchController {
	readonly #enabled: boolean;
	readonly #onHandoff: () => void;
	readonly #watcher: WorkspaceWatcher;
	#plans: readonly AdapterWatchPlanType[];
	#started = false;
	#closed = false;
	#watchRevision = 0;

	public constructor(options: AdapterWatchControllerOptionsType) {
		this.#enabled = options.enabled;
		this.#plans = options.plans;
		this.#onHandoff = options.onHandoff;
		this.#watcher = new WorkspaceWatcher({
			rootDir: options.rootDir,
			logger: options.logger,
			plans: options.plans,
			onChange: options.onChange,
		});
	}

	/** @returns The complete currently installed logical roster. */
	public get plans(): readonly AdapterWatchPlanType[] {
		return this.#plans;
	}

	public start(): void {
		this.#started = true;

		if (this.#enabled) {
			void this.#reconcileWhenReady(this.#watcher.start(this.#plans));
		}
	}

	/** @param plans - Complete replacement roster. */
	public update(plans: readonly AdapterWatchPlanType[]): void {
		const changed = plansChanged(this.#plans, plans);
		this.#plans = plans;
		const ready = this.#watcher.update(plans);

		if (changed && this.#enabled && this.#started) {
			void this.#reconcileWhenReady(ready);
		}
	}

	public close(): void {
		this.#closed = true;
		this.#watchRevision += 1;
		this.#watcher.close();
	}

	async #reconcileWhenReady(ready: Promise<void>): Promise<void> {
		const revision = this.#watchRevision + 1;
		this.#watchRevision = revision;
		await ready;

		if (!this.#closed && this.#watchRevision === revision) {
			this.#onHandoff();
		}
	}
}
