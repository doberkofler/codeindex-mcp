import {formatRecord} from './format.js';
import {type CatalogRecord} from './model.js';
import {CatalogStore} from './store.js';

export class CatalogService {
	readonly #store = new CatalogStore();

	public add(record: CatalogRecord): void {
		this.#store.put(record);
	}

	public describe(id: string): string {
		const record = this.#store.get(id);
		return record === undefined ? 'missing' : formatRecord(record);
	}
}
