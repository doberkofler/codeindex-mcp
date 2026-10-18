export function mergedWorker(): string {
	return 'merged';
}

// The empty namespace merges with the function symbol.
export namespace mergedWorker {}

export function mergedHelper(): string {
	return 'helper';
}

export namespace mergedHelper {}

export interface MergedShape {}

export interface MergedShape {}
