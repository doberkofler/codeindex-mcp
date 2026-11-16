import {type DatabaseSync} from 'node:sqlite';
import {type GenerationFactsInputType} from './databaseFactTypes.ts';

export const prepareOccurrenceContextStage = (writer: DatabaseSync): void => {
	writer.exec(`
		drop table if exists temp.occurrence_context_stage;
		create temp table occurrence_context_stage (
			symbol_id text not null,
			path text not null,
			start_offset integer not null,
			role text not null,
			adapter_id text not null,
			context_name text not null,
			generation_id text not null
		);
	`);
};

export const publishOccurrenceContextStage = (
	writer: DatabaseSync,
	_input: GenerationFactsInputType,
	_selected: ReadonlySet<string> | null,
	checkCancellation: (() => void) | undefined,
): void => {
	checkCancellation?.();
	writer.exec(`
		insert or ignore into occurrence_context (occurrence_key, context_key)
		select o.occurrence_key, c.context_key
		from temp.occurrence_context_stage staged
		join generation g on g.id = staged.generation_id
		join symbol s on s.generation_key = g.generation_key and s.id = staged.symbol_id
		join occurrence o
			on o.symbol_key = s.symbol_key
			and o.path_order = staged.path
			and o.start_offset = staged.start_offset
			and o.role = staged.role
			and o.adapter_id = staged.adapter_id
		join project_context c
			on c.generation_key = g.generation_key
			and c.adapter_id = staged.adapter_id
			and c.name = staged.context_name;
		drop table temp.occurrence_context_stage;
	`);
	checkCancellation?.();
};

export const prepareDefinitionSiteStage = (writer: DatabaseSync): void => {
	writer.exec(`
		drop table if exists temp.definition_site_stage;
		create temp table definition_site_stage (
			site_id text not null,
			symbol_id_order text not null,
			first_in_symbol integer not null,
			symbol_id text not null,
			path text not null,
			start_offset integer not null,
			generation_id text not null
		);
	`);
};

export const publishDefinitionSiteStage = (
	writer: DatabaseSync,
	_input: GenerationFactsInputType,
	_selected: ReadonlySet<string> | null,
	checkCancellation: (() => void) | undefined,
): void => {
	checkCancellation?.();
	writer.exec(`
		insert into definition_site
			(generation_key, site_id, occurrence_key, symbol_key, symbol_id_order, file_key, start_offset, first_in_symbol)
		select g.generation_key, staged.site_id, o.occurrence_key, o.symbol_key, staged.symbol_id_order,
			o.file_key, o.start_offset, staged.first_in_symbol
		from temp.definition_site_stage staged
		join generation g on g.id = staged.generation_id
		join symbol s on s.generation_key = g.generation_key and s.id = staged.symbol_id
		join occurrence o
			on o.symbol_key = s.symbol_key
			and o.path_order = staged.path
			and o.start_offset = staged.start_offset
			and o.role = 'definition';
		drop table temp.definition_site_stage;
	`);
	checkCancellation?.();
};
