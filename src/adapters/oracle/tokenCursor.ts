import {isOracleIdentifierText, namePartOf, type OracleNamePartType} from './name.ts';
import {type OracleTokenType} from './tokenize.ts';

export type OracleNameReadType = Readonly<{
	parts: readonly OracleNamePartType[];
	startIndex: number;
	endIndex: number;
	nextIndex: number;
}>;

export type OracleTokenRangeType = Readonly<{
	start: number;
	end: number;
	delimiter: number | null;
}>;

export type OracleBlockEndType = Readonly<{endIndex: number; nextIndex: number}>;

const BLOCK_END_LABELS = new Set(['IF', 'LOOP', 'CASE']);

/**
 * Navigation over visible Oracle tokens.
 *
 * Every declaration parser uses this cursor instead of retaining token indices
 * or duplicating delimiter arithmetic. Hidden tokens are deliberately absent.
 */
export class TokenCursor {
	readonly #tokens: readonly OracleTokenType[];

	public constructor(tokens: readonly OracleTokenType[]) {
		this.#tokens = tokens.filter((token) => token.channel === 'visible');
	}

	public get length(): number {
		return this.#tokens.length;
	}

	public token(index: number): OracleTokenType | undefined {
		return this.#tokens[index];
	}

	public text(index: number): string {
		return this.#tokens[index]?.text ?? '';
	}

	public upper(index: number): string {
		return this.text(index).toUpperCase();
	}

	public word(index: number, value: string): boolean {
		return this.upper(index) === value;
	}

	public identifier(index: number): boolean {
		return isOracleIdentifierText(this.text(index));
	}

	public eof(index: number): boolean {
		return index < 0 || index >= this.#tokens.length;
	}

	public next(index: number): number {
		return Math.min(index + 1, this.#tokens.length);
	}

	public previous(index: number): number {
		return this.#tokens.length === 0 ? -1 : Math.max(index - 1, -1);
	}

	public isSlashBoundary(index: number): boolean {
		if (this.text(index) !== '/') {
			return false;
		}

		const line = this.#tokens[index]?.startLine;
		const previousToken = this.#tokens[index - 1];
		const nextToken = this.#tokens[index + 1];

		return (previousToken === undefined || previousToken.startLine !== line) && (nextToken === undefined || nextToken.startLine !== line);
	}

	public isLineEnd(index: number): boolean {
		const nextToken = this.#tokens[index + 1];
		const line = this.#tokens[index]?.startLine;

		return nextToken === undefined || nextToken.startLine !== line;
	}

	public findDeclarationEnd(startIndex: number): number {
		let parenthesisDepth = 0;
		let caseDepth = 0;

		for (let index = Math.max(0, startIndex); index < this.#tokens.length; index += 1) {
			const text = this.text(index);

			if (text === '(') {
				parenthesisDepth += 1;
			} else if (text === ')') {
				parenthesisDepth = Math.max(0, parenthesisDepth - 1);
			} else if (this.word(index, 'CASE')) {
				caseDepth += 1;
			} else if (this.word(index, 'END') && caseDepth > 0) {
				caseDepth -= 1;
			} else if (text === ';' && parenthesisDepth === 0 && caseDepth === 0) {
				return index;
			}
		}

		return this.#tokens.length - 1;
	}

	public findBalancedClose(openIndex: number, boundary: number): number | null {
		let depth = 0;

		for (let index = openIndex; index <= boundary && index < this.#tokens.length; index += 1) {
			const text = this.text(index);

			if (text === '(') {
				depth += 1;
			} else if (text === ')') {
				depth -= 1;

				if (depth === 0) {
					return index;
				}
			}
		}

		return null;
	}

	public splitTopLevel(startIndex: number, endIndex: number, delimiter: string): readonly OracleTokenRangeType[] {
		if (startIndex < 0 || endIndex < startIndex || startIndex >= this.#tokens.length) {
			return [];
		}

		const ranges: OracleTokenRangeType[] = [];
		let rangeStart = startIndex;
		let parenthesisDepth = 0;
		let caseDepth = 0;

		for (let index = startIndex; index <= endIndex && index < this.#tokens.length; index += 1) {
			const text = this.text(index);

			if (text === '(') {
				parenthesisDepth += 1;
			} else if (text === ')') {
				parenthesisDepth = Math.max(0, parenthesisDepth - 1);
			} else if (this.word(index, 'CASE')) {
				caseDepth += 1;
			} else if (this.word(index, 'END') && caseDepth > 0) {
				caseDepth -= 1;
			} else if (text === delimiter && parenthesisDepth === 0 && caseDepth === 0) {
				ranges.push({start: rangeStart, end: Math.max(rangeStart, index - 1), delimiter: index});
				rangeStart = index + 1;
			}
		}

		if (rangeStart <= endIndex) {
			ranges.push({start: rangeStart, end: endIndex, delimiter: null});
		}

		return ranges.filter((range) => range.start <= range.end);
	}

	public readQualifiedName(startIndex: number): OracleNameReadType | null {
		if (!this.identifier(startIndex)) {
			return null;
		}

		const parts: OracleNamePartType[] = [namePartOf(this.text(startIndex))];
		let endIndex = startIndex;
		let cursor = startIndex;

		for (;;) {
			const dot = this.next(cursor);

			if (this.text(dot) !== '.') {
				break;
			}

			const component = this.next(dot);

			if (!this.identifier(component)) {
				break;
			}

			parts.push(namePartOf(this.text(component)));
			endIndex = component;
			cursor = component;
		}

		return {parts, startIndex, endIndex, nextIndex: this.next(endIndex)};
	}

	/**
	 * Finds the token index that closes one PL/SQL block.
	 *
	 * `BEGIN`, `IF`, `LOOP`, and `CASE` open a block; `END` consumes an optional
	 * label, `IF`, `LOOP`, or `CASE` and then the terminating semicolon.
	 *
	 * @param beginIndex - Index of the opening `BEGIN`.
	 * @returns The closing `END` index and the first token after the statement.
	 */
	public findBlockEnd(beginIndex: number): OracleBlockEndType {
		let depth = 0;

		for (let index = Math.max(0, beginIndex); index < this.#tokens.length; index += 1) {
			if (this.word(index, 'BEGIN') || this.word(index, 'IF') || this.word(index, 'LOOP') || this.word(index, 'CASE')) {
				depth += 1;
				continue;
			}

			if (!this.word(index, 'END')) {
				continue;
			}

			depth -= 1;

			let endIndex = index;
			let cursor = this.next(index);

			if (BLOCK_END_LABELS.has(this.upper(cursor)) || this.identifier(cursor)) {
				endIndex = cursor;
				cursor = this.next(cursor);
			}

			if (depth > 0) {
				index = cursor - 1;
				continue;
			}

			if (this.text(cursor) === ';') {
				return {endIndex, nextIndex: this.next(cursor)};
			}

			if (this.isSlashBoundary(cursor)) {
				return {endIndex, nextIndex: cursor};
			}

			return {endIndex, nextIndex: cursor};
		}

		return {endIndex: this.#tokens.length - 1, nextIndex: this.#tokens.length};
	}

	public findDirectiveEnd(startIndex: number): number {
		let endIndex = startIndex;

		for (let index = startIndex; index < this.#tokens.length; index += 1) {
			endIndex = index;

			if (this.isLineEnd(index)) {
				break;
			}
		}

		return endIndex;
	}

	public rawRange(
		startIndex: number,
		endIndex: number,
	): Readonly<{startOffset: number; endOffset: number; startLine: number; startColumn: number; endLine: number; endColumn: number}> {
		const start = this.#tokens[startIndex];
		const end = this.#tokens[Math.min(endIndex, this.#tokens.length - 1)];

		return {
			startOffset: start?.startOffset ?? 0,
			endOffset: end?.endOffset ?? 0,
			startLine: start?.startLine ?? 1,
			startColumn: start?.startColumn ?? 1,
			endLine: end?.endLine ?? 1,
			endColumn: end?.endColumn ?? 1,
		};
	}

	public sourceText(startIndex: number, endIndex: number): string {
		return this.#tokens
			.slice(startIndex, endIndex + 1)
			.map((token) => token.text)
			.join(' ');
	}
}
