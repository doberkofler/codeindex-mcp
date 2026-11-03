import {sourceTokenMatches, type ObjectMappingType} from './oracleMapping.ts';
import {type CodeOccurrenceType, type ExtraClassifierType} from './oracleTruth.ts';

export type ExtraClassifierInputType = Readonly<{
	mappings: ReadonlyMap<string, ObjectMappingType>;
	rowsByPath: ReadonlyMap<string, number>;
}>;

const isCallSpecName = (line: string, fact: CodeOccurrenceType): boolean => fact.name.toUpperCase() === 'LANGUAGE' && /\bLANGUAGE\s+(?:JAVA|C)\b/iu.test(line);

const isPragmaArgument = (line: string, fact: CodeOccurrenceType): boolean => /\bpragma\b/iu.test(line.slice(0, Math.max(0, fact.column - 1)));

/**
 * Builds a source-aware classifier for indexed facts without a PL/Scope row.
 *
 * Call-spec `LANGUAGE` tokens are extractor false positives, pragma arguments
 * are legitimate facts outside PL/Scope, and paths with no PL/Scope rows are
 * coverage gaps rather than local false positives.
 *
 * @param input - Source mappings and PL/Scope row counts by path.
 * @returns Extra-fact classifier for `compareFacts`.
 */
export const createExtraClassifier =
	(input: ExtraClassifierInputType): ExtraClassifierType =>
	(fact) => {
		const mapping = input.mappings.get(fact.path);

		if (mapping === undefined) {
			return 'false_positive';
		}

		const line = mapping.lines[fact.line - 1] ?? '';

		if (isCallSpecName(line, fact)) {
			return 'false_positive';
		}

		if (!sourceTokenMatches(mapping, fact, fact.name)) {
			return 'false_positive';
		}

		if (isPragmaArgument(line, fact)) {
			return 'outside_plscope';
		}

		return (input.rowsByPath.get(fact.path) ?? 0) === 0 ? 'outside_plscope' : 'false_positive';
	};
