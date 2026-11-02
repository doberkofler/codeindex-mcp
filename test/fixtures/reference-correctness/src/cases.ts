export const settings = {
	DEFAULT_FILL: 1,
	nested: {title: 'title'},
};

export function readSettings(): readonly unknown[] {
	return [settings.DEFAULT_FILL, settings.nested.title];
}

export class QueryThis {
	readonly getElements = 1;
	readonly shape: typeof this.getElements = this.getElements;
	readonly named = {this: 2};

	read(): number {
		return this.named.this + this.getElements;
	}
}

interface LeftShape {
	readonly shared: string;
}

interface RightShape {
	readonly shared: string;
}

export const readShared = (value: LeftShape | RightShape): string => value.shared;
