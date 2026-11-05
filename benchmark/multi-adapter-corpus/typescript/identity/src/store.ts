import {type IdentityRecord} from './model.js';

export class IdentityStore {
	readonly #records = new Map<string, IdentityRecord>();

	public put(record: IdentityRecord): void {
		this.#records.set(record.id, record);
	}

	public get(id: string): IdentityRecord | undefined {
		return this.#records.get(id);
	}
}
