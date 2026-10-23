/** One forbidden absolute path found in generated text or a provider request. */
export type PathDisclosureType = Readonly<{
	/** Index of the forbidden root in the caller's list. */
	rootIndex: number;
	/** Bounded absolute prefix that leaked. */
	prefix: string;
	/** Occurrences of this prefix in the inspected text. */
	count: number;
}>;

const occurrencesOf = (text: string, token: string): number => {
	if (token.length === 0) {
		return 0;
	}

	let count = 0;
	let index = text.indexOf(token);

	while (index !== -1) {
		count += 1;
		index = text.indexOf(token, index + token.length);
	}

	return count;
};

/**
 * Finds every occurrence of each forbidden absolute path.
 *
 * Matching is literal and case-sensitive because filesystem paths are. A
 * trailing separator is trimmed so callers may pass either form.
 *
 * @param text - Generated configuration, instructions, or provider request body.
 * @param forbiddenRoots - Absolute paths that must never be disclosed.
 * @returns One bounded record per disclosed root; empty when clean.
 */
export const pathDisclosuresOf = (text: string, forbiddenRoots: readonly string[]): readonly PathDisclosureType[] => {
	const roots = [...new Set(forbiddenRoots.map((root) => root.replace(/[\\/]+$/u, '')).filter((root) => root.length > 0))];

	return roots.flatMap((root, rootIndex) => {
		const count = occurrencesOf(text, root);

		return count === 0 ? [] : [{rootIndex, prefix: root, count}];
	});
};

/**
 * Counts disclosed forbidden paths without retaining the inspected text.
 *
 * @param text - Generated text or provider request body.
 * @param forbiddenRoots - Absolute paths that must never be disclosed.
 * @returns Total occurrence count.
 */
export const pathDisclosureCountOf = (text: string, forbiddenRoots: readonly string[]): number =>
	pathDisclosuresOf(text, forbiddenRoots).reduce((total, disclosure) => total + disclosure.count, 0);

/**
 * Requires generated text to disclose no forbidden path.
 *
 * @param text - Generated configuration or instructions.
 * @param forbiddenRoots - Absolute paths that must never be disclosed.
 * @param label - Evidence label used in the error.
 * @throws {@link Error} When any forbidden path occurs.
 */
export const assertNoPathDisclosure = (text: string, forbiddenRoots: readonly string[], label: string): void => {
	const disclosures = pathDisclosuresOf(text, forbiddenRoots);

	if (disclosures.length > 0) {
		throw new Error(`${label} discloses the primary checkout path: ${disclosures.map((item) => item.prefix).join(', ')}`);
	}
};
