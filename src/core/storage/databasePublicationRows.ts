import {z} from 'zod';
import {type BindingExposureType, type BindingSiteKindType, type SymbolSummaryType} from '../model.ts';
import {asNumber, asString} from './databaseRows.ts';

export type SqlRowType = Readonly<Record<string, unknown>>;

export const LineStartSchema = z.array(z.number().int().nonnegative());

export const asNullableString = (row: SqlRowType, key: string): string | null => {
	const value = row[key];
	return typeof value === 'string' ? value : null;
};

export const exposureOf = (value: string): BindingExposureType => {
	if (value === 'published' || value === 'reachable' || value === 'internal') {
		return value;
	}

	throw new TypeError(`Expected binding exposure, received ${value}`);
};

export const siteKindOf = (value: string): BindingSiteKindType => {
	if (
		value === 'declared' ||
		value === 'alias' ||
		value === 'default' ||
		value === 'reexport' ||
		value === 'wildcard' ||
		value === 'commonjs' ||
		value === 'surface'
	) {
		return value;
	}

	throw new TypeError(`Expected binding site kind, received ${value}`);
};

export const EXPOSURE_ORDER = `case exposure when 'published' then 2 when 'reachable' then 1 else 0 end`;

export const BINDING_COLUMNS = `n.binding_id, n.symbol_id, n.name, n.container, n.qualified_name,
	s.kind, s.path, s.start_line, s.start_column, s.end_line, s.end_column, s.start_offset, s.end_offset,
	s.enclosing_id, s.exposure as symbol_exposure`;

export const toSymbolSummary = (row: SqlRowType, contexts: readonly string[]): SymbolSummaryType => ({
	id: asString(row, 'symbol_id'),
	name: asString(row, 'name'),
	qualifiedName: asString(row, 'qualified_name'),
	kind: asString(row, 'kind'),
	path: asString(row, 'path'),
	startLine: asNumber(row, 'start_line'),
	startColumn: asNumber(row, 'start_column'),
	endLine: asNumber(row, 'end_line'),
	endColumn: asNumber(row, 'end_column'),
	enclosingId: asNullableString(row, 'enclosing_id'),
	startOffset: asNumber(row, 'start_offset'),
	endOffset: asNumber(row, 'end_offset'),
	contexts,
});
