import {formatRecord} from './format.js';
import {type IdentityRecord} from './model.js';
import {IdentityStore} from './store.js';

export class IdentityService {
	readonly #store = new IdentityStore();

	public add(record: IdentityRecord): void {
		this.#store.put(record);
	}

	public describe(id: string): string {
		const record = this.#store.get(id);
		return record === undefined ? 'missing' : formatRecord(record);
	}
}
