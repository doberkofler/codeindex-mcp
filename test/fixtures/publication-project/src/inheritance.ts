export class Base {
	public m(): void {}

	public baseOnly(): void {}
}

export class Derived extends Base {
	public override m(): void {}
}
