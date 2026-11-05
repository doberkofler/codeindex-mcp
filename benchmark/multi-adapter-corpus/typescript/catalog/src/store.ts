import {type CatalogRecord} from './model.js';

export class CatalogStore {
	readonly #records = new Map<string, CatalogRecord>();

	public put(record: CatalogRecord): void {
		this.#records.set(record.id, record);
	}

	public get(id: string): CatalogRecord | undefined {
		return this.#records.get(id);
	}
}
