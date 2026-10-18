export interface EdgeMerged {}

export interface EdgeMerged {}

export function mergedEdge(): string {
	return 'merged';
}

export namespace mergedEdge {}

export interface EdgeProps {
	readonly title: string;
	readonly tone: string;
}

export class EdgeBase {
	readonly kind = 'base';

	describe(): string {
		return this.kind;
	}
}

export class EdgeDerived extends EdgeBase {
	override describe(): string {
		return 'derived';
	}
}

export const edgeShorthandValue = 1;

export const edgeShorthand = {edgeShorthandValue};
