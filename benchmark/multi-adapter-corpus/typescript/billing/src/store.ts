import {type BillingRecord} from './model.js';

export class BillingStore {
	readonly #records = new Map<string, BillingRecord>();

	public put(record: BillingRecord): void {
		this.#records.set(record.id, record);
	}

	public get(id: string): BillingRecord | undefined {
		return this.#records.get(id);
	}
}
