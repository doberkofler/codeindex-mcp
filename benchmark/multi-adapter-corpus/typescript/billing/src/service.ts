import {formatRecord} from './format.js';
import {type BillingRecord} from './model.js';
import {BillingStore} from './store.js';

export class BillingService {
	readonly #store = new BillingStore();

	public add(record: BillingRecord): void {
		this.#store.put(record);
	}

	public describe(id: string): string {
		const record = this.#store.get(id);
		return record === undefined ? 'missing' : formatRecord(record);
	}
}
