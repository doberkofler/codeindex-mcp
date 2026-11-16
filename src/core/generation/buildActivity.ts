import {type IndexActivityType} from '../model.ts';
import {type RefreshReasonType} from '../freshness/refreshScope.ts';
import {type BuildProgressType} from './buildProgress.ts';

type ActivityStartType = Readonly<{
	reason: RefreshReasonType;
	force: boolean;
	adapterIds: readonly string[] | null;
}>;

export class BuildActivity {
	#current: IndexActivityType | null = null;

	public get current(): IndexActivityType | null {
		return this.#current;
	}

	public readonly update = (progress: BuildProgressType): void => {
		if (this.#current !== null) {
			this.#current = {...this.#current, ...progress};
		}
	};

	public async run<T>(start: ActivityStartType, action: () => Promise<T>): Promise<T> {
		this.#current = {...start, phase: 'waiting', adapterId: null, startedAt: new Date().toISOString()};

		try {
			return await action();
		} finally {
			this.#current = null;
		}
	}
}
