export default class MonotonicClock {
	private readonly origin = Date.now();

	public now(): number {
		return Date.now() - this.origin;
	}
}
