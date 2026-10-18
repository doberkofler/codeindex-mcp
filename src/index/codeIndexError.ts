import {type ErrorCodeType} from './errorCode.ts';

export class CodeIndexError extends Error {
	public readonly code: ErrorCodeType;

	public constructor(code: ErrorCodeType, message: string) {
		super(message);
		this.name = 'CodeIndexError';
		this.code = code;
	}
}
