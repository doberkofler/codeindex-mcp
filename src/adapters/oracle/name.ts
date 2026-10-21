import {type OracleNameReadType} from './tokenCursor.ts';

export type OracleNamePartType = Readonly<{
	/** Authored spelling, including quotes for delimited identifiers. */
	text: string;
	/** Canonical identity: upper-case for unquoted identifiers, exact for quoted. */
	canonical: string;
	quoted: boolean;
}>;

export type OracleNameType = Readonly<{
	parts: readonly OracleNamePartType[];
	/** Authored spelling joined with dots. */
	text: string;
	/** Canonical identity joined with dots. */
	canonical: string;
}>;

const UNQUOTED_IDENTIFIER = /^\p{Letter}[\p{Letter}0-9_$#]*$/u;
const QUOTED_IDENTIFIER = /^"(?:[^"]|"")*"$/u;

/**
 * Reports whether token text can be an Oracle identifier.
 *
 * Non-reserved keyword-shaped identifiers are accepted. Reserved words that
 * appear in a name position are left to the declaration parser's recovery path.
 *
 * @param text - Token text.
 * @returns Whether the text is an ordinary or delimited identifier.
 */
export const isOracleIdentifierText = (text: string): boolean => UNQUOTED_IDENTIFIER.test(text) || QUOTED_IDENTIFIER.test(text);

/**
 * Converts one authored name component into its source and canonical forms.
 *
 * @param text - Authored identifier spelling.
 * @returns The parsed name component.
 */
export const namePartOf = (text: string): OracleNamePartType => {
	const quoted = QUOTED_IDENTIFIER.test(text);

	return {
		text,
		canonical: quoted ? text : text.toUpperCase(),
		quoted,
	};
};

/**
 * Joins authored and canonical name components.
 *
 * @param input - Name components, optionally with a schema prefix.
 * @returns The complete Oracle name.
 */
export const oracleNameOf = (input: Readonly<{parts: readonly OracleNamePartType[]; displayParts?: readonly string[]}>): OracleNameType => ({
	parts: input.parts,
	text: (input.displayParts ?? input.parts.map((part) => part.text)).join('.'),
	canonical: input.parts.map((part) => part.canonical).join('.'),
});

/**
 * Canonicalises a configured default schema.
 *
 * @param schema - Manifest default schema spelling.
 * @returns The canonical schema identifier.
 */
export const defaultSchemaName = (schema: string): string => namePartOf(schema.trim()).canonical;

/**
 * Splits an authored object name into its schema and object parts.
 *
 * @param name - Authored qualified name.
 * @param defaultSchema - Schema used when the name is unqualified.
 * @returns Schema and object parts.
 */
export const splitObjectName = (name: OracleNameReadType, defaultSchema: string): Readonly<{schema: OracleNamePartType; object: OracleNamePartType}> => {
	const object = name.parts.at(-1) ?? namePartOf('');
	const schema = name.parts.length >= 2 ? (name.parts[0] ?? namePartOf(defaultSchema)) : namePartOf(defaultSchema);

	return {schema, object};
};
