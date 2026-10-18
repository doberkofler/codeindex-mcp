import {CodeIndexError} from './codeIndexError.ts';

export class StaleFileError extends CodeIndexError {
	public constructor(path: string) {
		super('stale_file', `Indexed source is stale for ${path}; rebuild the index or use normal file tools`);
		this.name = 'StaleFileError';
	}
}
