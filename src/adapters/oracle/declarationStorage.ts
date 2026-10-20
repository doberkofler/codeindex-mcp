import {type OracleDeclarationType, type OracleParseResultType} from './syntax.ts';

const isRoutine = (declaration: OracleDeclarationType): boolean => declaration.kind === 'procedure' || declaration.kind === 'function';

/**
 * Reports whether one declaration becomes a stored symbol.
 *
 * Parameters and declarations local to a routine are ephemeral. Nested named
 * routines remain stored as internal symbols. Package-spec and package-body
 * members are stored after whole-generation spec/body pairing.
 *
 * @param parse - Parsed file that owns the declaration.
 * @param declaration - Candidate declaration.
 * @returns Whether the declaration is persisted and searchable.
 */
export const isStoredOracleDeclaration = (parse: OracleParseResultType, declaration: OracleDeclarationType): boolean => {
	if (declaration.kind === 'parameter') {
		return false;
	}

	const {parent: initialParent} = declaration;
	let parent = initialParent;

	while (parent !== null) {
		const enclosing = parse.declarations[parent];

		if (enclosing === undefined) {
			return false;
		}

		if (isRoutine(enclosing)) {
			return isRoutine(declaration);
		}

		({parent} = enclosing);
	}

	return true;
};
