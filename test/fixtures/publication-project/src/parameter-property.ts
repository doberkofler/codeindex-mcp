export class WithParameterProperty {
	public constructor(
		public readonly value: string,
		private readonly hidden: number,
	) {
		void this.hidden;
	}
}
