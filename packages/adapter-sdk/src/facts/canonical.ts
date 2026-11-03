import {createHash} from 'node:crypto';
import {type FactAddressSegmentType, type FactAddressType} from './types.ts';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/**
 * Compares strings by UTF-16 code unit, independent of locale.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns Negative, zero, or positive in code-unit order.
 */
export const compareFactText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Serializes one address vector as the persisted canonical JSON form.
 *
 * @param segments - Address vector.
 * @returns Canonical JSON with no whitespace.
 */
export const serializeAddress = (segments: FactAddressType): string => JSON.stringify(segments);

/**
 * Creates one deterministic fact identifier.
 *
 * Every part is UTF-8 length-prefixed so adjacent parts cannot collide. The
 * identifier retains 96 bits of SHA-256 and is prefixed by entity type.
 *
 * @param prefix - Entity prefix, such as `b_` or `o_`.
 * @param parts - Natural-key parts.
 * @returns The prefixed deterministic identifier.
 */
export const createFactId = (prefix: 'b_' | 'o_', parts: readonly string[]): string => {
	const framed = parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part};`).join('');
	const digest = createHash('sha256').update(framed).digest('hex').slice(0, 24);

	return `${prefix}${digest}`;
};

const scopeDisplay = (segment: FactAddressSegmentType): string => {
	const [kind, value] = segment;

	if (kind === 'global') {
		return 'global';
	}

	if (kind === 'external_module') {
		return `external[${JSON.stringify(value)}]`;
	}

	return `${kind}[${JSON.stringify(value)}]`;
};

const segmentDisplay = (segment: FactAddressSegmentType, isFirst: boolean, followsScope: boolean): string => {
	const [kind, value] = segment;

	if (isFirst) {
		return scopeDisplay(segment);
	}

	if (kind === 'member') {
		if (typeof value === 'string' && IDENTIFIER.test(value)) {
			return followsScope ? `::${value}` : `.${value}`;
		}

		const member = `[${JSON.stringify(value)}]`;

		return followsScope ? `::${member}` : member;
	}

	if (value === null) {
		return `::${kind}`;
	}

	return `::${kind}[${typeof value === 'number' ? String(value) : JSON.stringify(value)}]`;
};

const displayAddress = (segments: FactAddressType): string => segments.map((segment, index) => segmentDisplay(segment, index === 0, index === 1)).join('');

/**
 * Derives the display and search fields from one canonical address vector.
 *
 * @param segments - Address vector.
 * @returns Container, terminal name, and qualified display.
 */
export const displayBinding = (segments: FactAddressType): Readonly<{container: string; name: string; qualifiedName: string}> => {
	const terminal = segments.at(-1);
	const prefixSegments = segments.slice(0, -1);
	const container = prefixSegments.length === 0 ? '' : displayAddress(prefixSegments);
	const qualifiedName = displayAddress(segments);

	if (terminal === undefined) {
		return {container, name: '', qualifiedName};
	}

	const [kind, value] = terminal;

	if (kind === 'member' && typeof value === 'string') {
		return {container, name: value, qualifiedName};
	}

	return {container, name: kind, qualifiedName};
};
