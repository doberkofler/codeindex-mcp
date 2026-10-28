const DISPLAY_MARKERS = ['::', '['] as const;
const LOWER_ASCII_LETTER = /[a-z]/u;

/**
 * Reports whether authored text already uses the canonical display form.
 *
 * Display names are produced from persisted addresses, so their structure is
 * canonical by construction. Rewriting them would risk altering scope keywords.
 *
 * @param text - Authored query or filter text.
 * @returns Whether the text contains a canonical display marker.
 */
const isDisplayForm = (text: string): boolean => DISPLAY_MARKERS.some((marker) => text.includes(marker));

/**
 * Normalizes one authored Oracle name to the canonical published spelling.
 *
 * Oracle folds unquoted identifiers to upper case and preserves delimited
 * identifiers exactly. Published bindings already hold that canonical spelling,
 * so a raw mixed-case query must be folded before it can match them.
 *
 * @param text - Authored simple, qualified, or display-form name.
 * @returns Canonical name that compares against published bindings.
 */
export const normalizeOracleQueryName = (text: string): string => {
	if (isDisplayForm(text)) {
		return text;
	}

	let normalized = '';
	let quoted = false;
	let index = 0;

	while (index < text.length) {
		const character = text[index] ?? '';

		if (character === '"') {
			// A doubled quote inside a delimited identifier is an escaped quote, not a terminator.
			const escaped = text[index + 1] === '"';
			normalized += escaped ? '""' : '"';
			index += escaped ? 2 : 1;

			if (!escaped) {
				quoted = !quoted;
			}

			continue;
		}

		normalized += !quoted && LOWER_ASCII_LETTER.test(character) ? character.toUpperCase() : character;
		index += 1;
	}

	return normalized;
};
