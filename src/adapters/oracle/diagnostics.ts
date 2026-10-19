import {type DiagnosticType} from '../../core/model.ts';

/**
 * Oracle adapter diagnostic codes.
 *
 * Codes are stable within the adapter and become part of persisted facts.
 */
export const ORACLE_DIAGNOSTIC = {
	lexer: 9101,
	parse: 9102,
	wrappedUnit: 9103,
	malformedDeclaration: 9104,
	ambiguousOverload: 9105,
	ambiguousPackage: 9106,
	diagnosticOverflow: 9107,
} as const;

export type OracleDiagnosticCodeType = (typeof ORACLE_DIAGNOSTIC)[keyof typeof ORACLE_DIAGNOSTIC];

const MAX_DIAGNOSTICS_PER_FILE = 20;

/**
 * Creates one bounded Oracle diagnostic.
 *
 * @param input - Code, message, and optional source location.
 * @returns A serializable core diagnostic.
 */
const oracleDiagnostic = (
	input: Readonly<{
		code: OracleDiagnosticCodeType;
		message: string;
		path: string;
		line: number | null;
		column: number | null;
	}>,
): DiagnosticType => ({
	category: 'warning',
	code: input.code,
	message: input.message.slice(0, 300),
	path: input.path,
	startLine: input.line,
	startColumn: input.column,
});

/**
 * Collects bounded diagnostics for one file.
 *
 * Overflow is represented by one synthetic diagnostic so malformed input cannot
 * inflate persisted generations or response sizes.
 */
export class OracleDiagnosticCollector {
	readonly #path: string;
	readonly #diagnostics: DiagnosticType[] = [];
	#overflowed = false;

	public constructor(path: string) {
		this.#path = path;
	}

	/**
	 * Adds one diagnostic unless the per-file bound is reached.
	 *
	 * @param code - Stable Oracle diagnostic code.
	 * @param message - Bounded human-readable message.
	 * @param line - One-based line, when known.
	 * @param column - One-based column, when known.
	 */
	public add(code: OracleDiagnosticCodeType, message: string, line: number | null = null, column: number | null = null): void {
		if (this.#diagnostics.length >= MAX_DIAGNOSTICS_PER_FILE) {
			this.#overflowed = true;
			return;
		}

		this.#diagnostics.push(oracleDiagnostic({code, message, path: this.#path, line, column}));
	}

	/**
	 * Returns collected diagnostics, including an overflow marker when needed.
	 *
	 * @returns Bounded diagnostics for one file.
	 */
	public finish(): readonly DiagnosticType[] {
		if (!this.#overflowed) {
			return [...this.#diagnostics];
		}

		return [
			...this.#diagnostics,
			oracleDiagnostic({
				code: ORACLE_DIAGNOSTIC.diagnosticOverflow,
				message: 'Additional Oracle diagnostics were suppressed for this file',
				path: this.#path,
				line: null,
				column: null,
			}),
		];
	}
}
