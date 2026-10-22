/**
 * Deterministic pseudo-random source for bootstrap resampling.
 *
 * The generator is a mulberry32 xorshift. Its arithmetic is defined on 32-bit
 * integers, so XOR, shifts, and `>>> 0` are the algorithm itself; the project
 * `no-bitwise` policy targets mistyped boolean logic, not this construction.
 */

/** Divisor that maps a 32-bit unsigned integer onto [0, 1). */
const UINT32_RANGE = 4_294_967_296;

/** Increment mixed into the state on every draw (0x6D2B79F5). */
const GOLDEN_GAMMA = 1_831_565_813;

/**
 * Builds a deterministic random source from a hexadecimal seed prefix.
 *
 * @param seed - Digest whose first eight hexadecimal characters seed the state.
 * @returns A function that yields the next value in [0, 1).
 */
export const rngOf = (seed: string): (() => number) => {
	let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;

	return (): number => {
		state = (state + GOLDEN_GAMMA) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

		return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
	};
};
