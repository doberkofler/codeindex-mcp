import {CodeIndexError} from './codeIndexError.ts';

export class IndexNotReadyError extends CodeIndexError {
	public constructor(message = 'No published index generation exists yet') {
		super('index_not_ready', message);
		this.name = 'IndexNotReadyError';
	}
}
