import {type PlatformRecord} from './model.js';

export class PlatformStore {
	readonly #records = new Map<string, PlatformRecord>();

	public put(record: PlatformRecord): void {
		this.#records.set(record.id, record);
	}

	public get(id: string): PlatformRecord | undefined {
		return this.#records.get(id);
	}
}
