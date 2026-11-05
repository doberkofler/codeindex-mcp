import {type ReportingRecord} from './model.js';

export class ReportingStore {
	readonly #records = new Map<string, ReportingRecord>();

	public put(record: ReportingRecord): void {
		this.#records.set(record.id, record);
	}

	public get(id: string): ReportingRecord | undefined {
		return this.#records.get(id);
	}
}
