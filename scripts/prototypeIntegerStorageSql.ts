export type VariantType = 'narrow' | 'ordered';

const BASE_SCHEMA_SQL = `
pragma foreign_keys = on;

create table metadata (key text primary key, value text not null);
create table working_copy (
	id text primary key, canonical_root text not null, vcs_kind text not null, vcs_repository text, vcs_revision text,
	vcs_relative_root text, created_at text not null, last_seen_at text not null
);
create table indexed_project (
	id text not null, working_copy_id text not null references working_copy(id) on delete cascade, adapter_id text not null,
	project_file text not null, compiler_version text not null, extractor_version text not null, created_at text not null,
	primary key (working_copy_id, adapter_id, project_file)
);
create table content (
	sha256 text primary key, byte_count integer not null, line_count integer not null, encoding text not null,
	line_starts text not null, bytes blob not null
);
create table generation (
	generation_key integer primary key, id text not null unique, state text not null, source_hash text not null,
	config_hash text not null, input_hash text not null, started_at text not null, completed_at text, revision integer not null,
	file_count integer not null, symbol_count integer not null, occurrence_count integer not null,
	dependency_edge_count integer not null, dependency_binding_count integer not null, diagnostic_count integer not null,
	scan_ms integer, compiler_ms integer, extraction_ms integer, insertion_ms integer, verification_ms integer,
	publication_ms integer, error text
);
create table generation_adapter (
	generation_key integer not null references generation(generation_key) on delete cascade, adapter_id text not null,
	revision integer not null, protocol_version integer not null, adapter_version text not null, package_name text,
	package_version text, compiler_version text not null, declared_compiler_version text, compiler_drift integer not null,
	coverage text not null, absence_reason text, source_hash text not null, config_hash text not null, input_hash text not null,
	file_count integer not null, symbol_count integer not null, occurrence_count integer not null,
	dependency_edge_count integer not null, dependency_binding_count integer not null, diagnostic_count integer not null,
	scan_ms integer, compiler_ms integer, extraction_ms integer, primary key (generation_key, adapter_id)
);
create table project_context (
	context_key integer primary key, generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null, name text not null, project_file text not null, config_hash text not null,
	unique (generation_key, adapter_id, name)
);
create table file (
	file_key integer primary key, generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null, path text not null, sha256 text not null, content_sha256 text references content(sha256),
	line_count integer not null, unique (generation_key, path)
);
create table generation_file_digest (
	file_key integer primary key references file(file_key) on delete cascade, adapter_id text not null, digest text not null
);
create table symbol (
	symbol_key integer primary key, generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null, id text not null, name text not null, qualified_name text not null, kind text not null,
	file_key integer not null references file(file_key) on delete cascade, start_line integer not null,
	start_column integer not null, end_line integer not null, end_column integer not null, start_offset integer not null,
	end_offset integer not null, enclosing_symbol_key integer references symbol(symbol_key) on delete cascade deferrable initially deferred,
	external_target text, external_name text, exposure text not null, unique (generation_key, id)
);
create table symbol_context (
	symbol_key integer not null references symbol(symbol_key) on delete cascade,
	context_key integer not null references project_context(context_key) on delete cascade, primary key (symbol_key, context_key)
);
create table symbol_name (
	symbol_name_key integer primary key, generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null, binding_id text not null, symbol_key integer not null references symbol(symbol_key) on delete cascade,
	binding_key text not null, container text not null, name text not null, qualified_name text not null, exposure text not null,
	has_declared_site integer not null, unique (generation_key, binding_id), unique (symbol_key, binding_key)
);
create table symbol_name_context (
	symbol_name_key integer not null references symbol_name(symbol_name_key) on delete cascade,
	context_key integer not null references project_context(context_key) on delete cascade, exposure text not null,
	primary key (symbol_name_key, context_key)
);
create table symbol_name_site (
	symbol_name_key integer not null references symbol_name(symbol_name_key) on delete cascade,
	file_key integer not null references file(file_key) on delete cascade, kind text not null, start_line integer not null,
	start_column integer not null, end_line integer not null, end_column integer not null, start_offset integer not null,
	end_offset integer not null, primary key (symbol_name_key, file_key, start_offset)
);
create table surface_binding_origin (
	symbol_name_key integer not null, context_key integer not null, root_symbol_name_key integer not null,
	relative_key text not null, primary key (symbol_name_key, context_key),
	foreign key (symbol_name_key, context_key) references symbol_name_context(symbol_name_key, context_key) on delete cascade,
	foreign key (root_symbol_name_key, context_key) references symbol_name_context(symbol_name_key, context_key) on delete cascade
);
`;

export const schemaSql = (variant: VariantType): string => `${BASE_SCHEMA_SQL}
create table occurrence (
	occurrence_key integer primary key, generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null, symbol_key integer not null references symbol(symbol_key) on delete cascade,
	file_key integer not null references file(file_key) on delete cascade, ${variant === 'ordered' ? 'path_order text not null, symbol_id_order text not null,' : ''} start_line integer not null,
	start_column integer not null, end_line integer not null, end_column integer not null, start_offset integer not null,
	end_offset integer not null, role text not null, enclosing_symbol_key integer references symbol(symbol_key) on delete cascade deferrable initially deferred,
	declaration_kind text, forward_definition integer not null, usage integer not null, extent_start integer, extent_end integer,
	anchor_rank integer, primary_rank integer, unique (symbol_key, ${variant === 'ordered' ? 'path_order' : 'file_key'}, start_offset, role)
);
create table occurrence_context (
	occurrence_key integer not null references occurrence(occurrence_key) on delete cascade,
	context_key integer not null references project_context(context_key) on delete cascade, primary key (occurrence_key, context_key)
);
create table definition_site (
	definition_site_key integer primary key,
	generation_key integer not null references generation(generation_key) on delete cascade,
	site_id text not null, occurrence_key integer not null unique references occurrence(occurrence_key) on delete cascade,
	${variant === 'ordered' ? 'symbol_key integer not null references symbol(symbol_key) on delete cascade, symbol_id_order text not null, file_key integer not null references file(file_key) on delete cascade, start_offset integer not null,' : ''}
	first_in_symbol integer not null, unique (generation_key, site_id)
);
create table dependency_edge (
	edge_key integer primary key, generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null, id text not null, context_key integer references project_context(context_key) on delete cascade,
	source_file_key integer not null references file(file_key) on delete cascade,
	target_file_key integer references file(file_key) on delete set null, raw_target text not null, target_identifier text,
	kind text not null, compile_time_only integer not null, start_line integer not null, start_column integer not null,
	end_line integer not null, end_column integer not null, start_offset integer not null, end_offset integer not null,
	unique (generation_key, id)
);
create table dependency_binding (
	edge_key integer not null references dependency_edge(edge_key) on delete cascade, position integer not null,
	kind text not null, imported_name text, exported_name text, local_name text, compile_time_only integer not null,
	primary key (edge_key, position)
);
create table diagnostic (
	generation_key integer not null references generation(generation_key) on delete cascade, adapter_id text not null,
	position integer not null, category text not null, code integer not null, message text not null,
	file_key integer references file(file_key) on delete cascade, fallback_path text, start_line integer, start_column integer,
	primary key (generation_key, adapter_id, position), check (file_key is null or fallback_path is null)
);
create table build_stats (
	generation_key integer not null references generation(generation_key) on delete cascade, adapter_id text not null,
	language text not null, metric text not null, dim1 text not null, dim2 text not null, dim3 text not null,
	value integer not null, primary key (generation_key, adapter_id, language, metric, dim1, dim2, dim3)
);
create table extraction_artifact (
	content_sha256 text not null references content(sha256) on delete cascade, artifact_kind text not null,
	extractor_id text not null, extractor_version text not null, context_hash text not null, artifact_json text not null,
	created_at text not null, last_used_at text not null,
	primary key (content_sha256, artifact_kind, extractor_id, extractor_version, context_hash)
);
create table build_lease (
	project_id text primary key, owner_id text not null, process_id integer not null, acquired_at text not null,
	heartbeat_at text not null, expires_at text not null
);
`;

export const indexSql = (variant: VariantType): string => `
create index file_by_content on file (content_sha256);
create index file_by_adapter on file (generation_key, adapter_id, path);
create index generation_file_digest_by_adapter on generation_file_digest (adapter_id, file_key);
create index symbol_context_by_context on symbol_context (context_key, symbol_key);
create index symbol_by_path on symbol (generation_key, file_key, start_offset);
create index symbol_by_adapter on symbol (generation_key, adapter_id, file_key, start_offset);
create index symbol_by_name on symbol (generation_key, name);
create index symbol_by_qualified_name on symbol (generation_key, qualified_name);
create index symbol_by_enclosing on symbol (generation_key, enclosing_symbol_key);
create index symbol_name_by_name on symbol_name (generation_key, name, container, binding_id, symbol_key, adapter_id, exposure, has_declared_site, qualified_name);
create index symbol_name_by_qualified_name on symbol_name (generation_key, qualified_name);
create index symbol_name_by_container_name on symbol_name (generation_key, container, name);
create index symbol_name_context_by_exposure on symbol_name_context (context_key, exposure, symbol_name_key);
create index symbol_name_site_by_path on symbol_name_site (file_key, kind, start_offset);
create index surface_binding_origin_by_root on surface_binding_origin (root_symbol_name_key, context_key);
create index occurrence_context_by_context on occurrence_context (context_key, occurrence_key);
create index occurrence_by_path on occurrence (generation_key, file_key, role, start_offset, symbol_key, end_offset);
create index occurrence_by_adapter on occurrence (generation_key, adapter_id, file_key, role, start_offset);
create index occurrence_by_extent on occurrence (generation_key, file_key, role, extent_start);
create index occurrence_by_enclosing on occurrence (generation_key, enclosing_symbol_key);
create index definition_site_by_path on definition_site (${variant === 'ordered' ? 'generation_key, file_key, first_in_symbol, start_offset, symbol_id_order' : 'generation_key, first_in_symbol, occurrence_key'});
create index dependency_by_target_identifier on dependency_edge (generation_key, target_identifier, source_file_key);
create index dependency_by_target on dependency_edge (generation_key, target_file_key, source_file_key);
create index dependency_by_source on dependency_edge (generation_key, source_file_key, start_offset);
`;

const BASE_COPY_SQL: readonly string[] = [
	`insert into metadata select * from source.metadata where key <> 'schema_version'`,
	`insert into metadata values ('schema_version', 'prototype')`,
	`insert into working_copy select * from source.working_copy`,
	`insert into indexed_project select * from source.indexed_project`,
	`insert into content select * from source.content`,
	`insert into generation
		(id, state, source_hash, config_hash, input_hash, started_at, completed_at, revision, file_count, symbol_count,
		 occurrence_count, dependency_edge_count, dependency_binding_count, diagnostic_count, scan_ms, compiler_ms,
		 extraction_ms, insertion_ms, verification_ms, publication_ms, error)
		select id, state, source_hash, config_hash, input_hash, started_at, completed_at, revision, file_count, symbol_count,
		 occurrence_count, dependency_edge_count, dependency_binding_count, diagnostic_count, scan_ms, compiler_ms,
		 extraction_ms, insertion_ms, verification_ms, publication_ms, error from source.generation order by rowid`,
	`create temp table generation_map as
		select source.id, target.generation_key from source.generation source join generation target on target.id = source.id`,
	`insert into generation_adapter
		(generation_key, adapter_id, revision, protocol_version, adapter_version, package_name, package_version, compiler_version,
		 declared_compiler_version, compiler_drift, coverage, absence_reason, source_hash, config_hash, input_hash, file_count,
		 symbol_count, occurrence_count, dependency_edge_count, dependency_binding_count, diagnostic_count, scan_ms, compiler_ms, extraction_ms)
		select gm.generation_key, a.adapter_id, 1, a.protocol_version, a.adapter_version, a.package_name, a.package_version,
		 a.compiler_version, a.declared_compiler_version, a.compiler_drift, a.coverage, a.absence_reason, a.source_hash,
		 a.config_hash, a.input_hash, a.file_count, a.symbol_count, a.occurrence_count, a.dependency_edge_count,
		 a.dependency_binding_count, a.diagnostic_count, a.scan_ms, a.compiler_ms, a.extraction_ms
		from source.generation_adapter a join generation_map gm on gm.id = a.generation_id`,
	`insert into project_context (generation_key, adapter_id, name, project_file, config_hash)
		select gm.generation_key, c.adapter_id, c.name, c.project_file, c.config_hash
		from source.project_context c join generation_map gm on gm.id = c.generation_id order by c.rowid`,
	`create temp table context_map as
		select gm.id generation_id, c.adapter_id, c.name, c.context_key from project_context c
		join generation_map gm on gm.generation_key = c.generation_key`,
	`insert into file (generation_key, adapter_id, path, sha256, content_sha256, line_count)
		select gm.generation_key, f.adapter_id, f.path, f.sha256, f.content_sha256, f.line_count
		from source.file f join generation_map gm on gm.id = f.generation_id order by f.rowid`,
	`create temp table file_map as
		select gm.id generation_id, f.path, f.file_key from file f join generation_map gm on gm.generation_key = f.generation_key`,
	`insert into generation_file_digest (file_key, adapter_id, digest)
		select fm.file_key, d.adapter_id, d.digest from source.generation_file_digest d
		join file_map fm on fm.generation_id = d.generation_id and fm.path = d.path`,
	`insert into symbol
		(generation_key, adapter_id, id, name, qualified_name, kind, file_key, start_line, start_column, end_line, end_column,
		 start_offset, end_offset, enclosing_symbol_key, external_target, external_name, exposure)
		select gm.generation_key, s.adapter_id, s.id, s.name, s.qualified_name, s.kind, fm.file_key, s.start_line, s.start_column,
		 s.end_line, s.end_column, s.start_offset, s.end_offset, null, s.external_target, s.external_name, s.exposure
		from source.symbol s join generation_map gm on gm.id = s.generation_id
		join file_map fm on fm.generation_id = s.generation_id and fm.path = s.path order by s.rowid`,
	`create temp table symbol_map as
		select gm.id generation_id, s.id, s.symbol_key from symbol s join generation_map gm on gm.generation_key = s.generation_key`,
	`update symbol set enclosing_symbol_key = (
		select parent.symbol_key from source.symbol original
		join generation_map gm on gm.id = original.generation_id
		join symbol_map parent on parent.generation_id = original.generation_id and parent.id = original.enclosing_id
		where gm.generation_key = symbol.generation_key and original.id = symbol.id)
		where exists (
			select 1 from source.symbol original join generation_map gm on gm.id = original.generation_id
			where gm.generation_key = symbol.generation_key and original.id = symbol.id and original.enclosing_id is not null)`,
	`insert into symbol_context
		select sm.symbol_key, cm.context_key from source.symbol_context c
		join symbol_map sm on sm.generation_id = c.generation_id and sm.id = c.symbol_id
		join context_map cm on cm.generation_id = c.generation_id and cm.adapter_id = c.adapter_id and cm.name = c.context_name`,
	`insert into symbol_name
		(generation_key, adapter_id, binding_id, symbol_key, binding_key, container, name, qualified_name, exposure, has_declared_site)
		select gm.generation_key, n.adapter_id, n.binding_id, sm.symbol_key, n.binding_key, n.container, n.name, n.qualified_name,
		 n.exposure, n.has_declared_site from source.symbol_name n
		join generation_map gm on gm.id = n.generation_id
		join symbol_map sm on sm.generation_id = n.generation_id and sm.id = n.symbol_id order by n.rowid`,
	`create temp table binding_map as
		select gm.id generation_id, n.binding_id, n.symbol_name_key from symbol_name n
		join generation_map gm on gm.generation_key = n.generation_key`,
	`insert into symbol_name_context
		select bm.symbol_name_key, cm.context_key, c.exposure from source.symbol_name_context c
		join binding_map bm on bm.generation_id = c.generation_id and bm.binding_id = c.binding_id
		join context_map cm on cm.generation_id = c.generation_id and cm.adapter_id = c.adapter_id and cm.name = c.context_name`,
	`insert into symbol_name_site
		select bm.symbol_name_key, fm.file_key, site.kind, site.start_line, site.start_column, site.end_line, site.end_column,
		 site.start_offset, site.end_offset from source.symbol_name_site site
		join binding_map bm on bm.generation_id = site.generation_id and bm.binding_id = site.binding_id
		join file_map fm on fm.generation_id = site.generation_id and fm.path = site.path`,
	`insert into surface_binding_origin
		select bm.symbol_name_key, cm.context_key, root.symbol_name_key, o.relative_key from source.surface_binding_origin o
		join binding_map bm on bm.generation_id = o.generation_id and bm.binding_id = o.binding_id
		join binding_map root on root.generation_id = o.generation_id and root.binding_id = o.root_binding_id
		join context_map cm on cm.generation_id = o.generation_id and cm.adapter_id = o.adapter_id and cm.name = o.context_name`,
];

const occurrenceCopySql = (variant: VariantType): string => `insert into occurrence
		(generation_key, adapter_id, symbol_key, file_key, ${variant === 'ordered' ? 'path_order, symbol_id_order,' : ''} start_line, start_column, end_line, end_column, start_offset,
		 end_offset, role, enclosing_symbol_key, declaration_kind, forward_definition, usage, extent_start, extent_end,
		 anchor_rank, primary_rank)
		select gm.generation_key, o.adapter_id, sm.symbol_key, fm.file_key, ${variant === 'ordered' ? 'o.path, o.symbol_id,' : ''} o.start_line, o.start_column, o.end_line,
		 o.end_column, o.start_offset, o.end_offset, o.role, enclosing.symbol_key, o.declaration_kind, o.forward_definition,
		 o.usage, o.extent_start, o.extent_end, o.anchor_rank, o.primary_rank
		from source.occurrence o join generation_map gm on gm.id = o.generation_id
		join symbol_map sm on sm.generation_id = o.generation_id and sm.id = o.symbol_id
		join file_map fm on fm.generation_id = o.generation_id and fm.path = o.path
		left join symbol_map enclosing on enclosing.generation_id = o.generation_id and enclosing.id = o.enclosing_id
		order by o.rowid`;

const OCCURRENCE_CONTEXT_COPY_SQL: readonly string[] = [
	`create temp table occurrence_map as
		select gm.id generation_id, sm.id symbol_id, fm.path, o.start_offset, o.role, o.occurrence_key
		from occurrence o join generation_map gm on gm.generation_key = o.generation_key
		join symbol_map sm on sm.symbol_key = o.symbol_key join file_map fm on fm.file_key = o.file_key`,
	`insert into occurrence_context
		select om.occurrence_key, cm.context_key from source.occurrence_context c
		join occurrence_map om on om.generation_id = c.generation_id and om.symbol_id = c.symbol_id and om.path = c.path
		 and om.start_offset = c.start_offset and om.role = c.role
		join context_map cm on cm.generation_id = c.generation_id and cm.adapter_id = c.adapter_id and cm.name = c.context_name`,
];

const definitionSiteCopySql = (variant: VariantType): string =>
	variant === 'ordered'
		? `insert into definition_site (generation_key, site_id, occurrence_key, symbol_key, symbol_id_order, file_key, start_offset, first_in_symbol)
			select gm.generation_key, d.site_id, om.occurrence_key, sm.symbol_key, d.symbol_id, fm.file_key, d.start_offset, d.first_in_symbol
			from source.definition_site d join generation_map gm on gm.id = d.generation_id
			join occurrence_map om on om.generation_id = d.generation_id and om.symbol_id = d.symbol_id and om.path = d.path
			 and om.start_offset = d.start_offset and om.role = d.role
			join symbol_map sm on sm.generation_id = d.generation_id and sm.id = d.symbol_id
			join file_map fm on fm.generation_id = d.generation_id and fm.path = d.path`
		: `insert into definition_site (generation_key, site_id, occurrence_key, first_in_symbol)
			select gm.generation_key, d.site_id, om.occurrence_key, d.first_in_symbol
			from source.definition_site d join generation_map gm on gm.id = d.generation_id
			join occurrence_map om on om.generation_id = d.generation_id and om.symbol_id = d.symbol_id and om.path = d.path
			 and om.start_offset = d.start_offset and om.role = d.role`;

const FINAL_COPY_SQL: readonly string[] = [
	`insert into dependency_edge
		(generation_key, adapter_id, id, context_key, source_file_key, target_file_key, raw_target, target_identifier, kind,
		 compile_time_only, start_line, start_column, end_line, end_column, start_offset, end_offset)
		select gm.generation_key, e.adapter_id, e.id, cm.context_key, source_file.file_key, target_file.file_key,
		 e.raw_target, e.target_identifier, e.kind, e.compile_time_only, e.start_line, e.start_column, e.end_line,
		 e.end_column, e.start_offset, e.end_offset from source.dependency_edge e
		join generation_map gm on gm.id = e.generation_id
		join file_map source_file on source_file.generation_id = e.generation_id and source_file.path = e.source_path
		left join file_map target_file on target_file.generation_id = e.generation_id and target_file.path = e.target_path
		left join context_map cm on cm.generation_id = e.generation_id and cm.adapter_id = e.adapter_id and cm.name = e.context_name
		order by e.rowid`,
	`create temp table edge_map as
		select gm.id generation_id, e.id, e.edge_key from dependency_edge e
		join generation_map gm on gm.generation_key = e.generation_key`,
	`insert into dependency_binding
		select em.edge_key, b.position, b.kind, b.imported_name, b.exported_name, b.local_name, b.compile_time_only
		from source.dependency_binding b join edge_map em on em.generation_id = b.generation_id and em.id = b.edge_id`,
	`insert into diagnostic
		select gm.generation_key, d.adapter_id, d.position, d.category, d.code, d.message, fm.file_key,
			case when fm.file_key is null then d.path else null end, d.start_line, d.start_column
		from source.diagnostic d join generation_map gm on gm.id = d.generation_id
		left join file_map fm on fm.generation_id = d.generation_id and fm.path = d.path`,
	`insert into build_stats
		select gm.generation_key, s.adapter_id, s.language, s.metric, s.dim1, s.dim2, s.dim3, s.value
		from source.build_stats s join generation_map gm on gm.id = s.generation_id`,
	`insert into extraction_artifact select * from source.extraction_artifact`,
	`insert into build_lease select * from source.build_lease`,
];

export const copySql = (variant: VariantType): readonly string[] => [
	...BASE_COPY_SQL,
	occurrenceCopySql(variant),
	...OCCURRENCE_CONTEXT_COPY_SQL,
	definitionSiteCopySql(variant),
	...FINAL_COPY_SQL,
];
