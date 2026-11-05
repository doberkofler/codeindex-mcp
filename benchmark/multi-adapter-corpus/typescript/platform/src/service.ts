import {formatRecord} from './format.js';
import {type PlatformRecord} from './model.js';
import {PlatformStore} from './store.js';

export class PlatformService {
	readonly #store = new PlatformStore();

	public add(record: PlatformRecord): void {
		this.#store.put(record);
	}

	public describe(id: string): string {
		const record = this.#store.get(id);
		return record === undefined ? 'missing' : formatRecord(record);
	}
}
