import {formatRecord} from './format.js';
import {type ReportingRecord} from './model.js';
import {ReportingStore} from './store.js';

export class ReportingService {
	readonly #store = new ReportingStore();

	public add(record: ReportingRecord): void {
		this.#store.put(record);
	}

	public describe(id: string): string {
		const record = this.#store.get(id);
		return record === undefined ? 'missing' : formatRecord(record);
	}
}
