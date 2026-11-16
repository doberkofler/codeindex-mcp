export const SCHEMA_VERSION = '19';

export const SCHEMA_SQL = `
pragma foreign_keys = on;

create table if not exists metadata (
	key text primary key,
	value text not null
);

create table if not exists working_copy (
	id text primary key,
	canonical_root text not null,
	vcs_kind text not null default 'none' check (vcs_kind in ('git', 'svn', 'none')),
	vcs_repository text,
	vcs_revision text,
	vcs_relative_root text,
	created_at text not null,
	last_seen_at text not null
);

create table if not exists indexed_project (
	id text not null,
	working_copy_id text not null references working_copy(id) on delete cascade,
	adapter_id text not null,
	project_file text not null,
	compiler_version text not null,
	extractor_version text not null,
	created_at text not null,
	primary key (working_copy_id, adapter_id, project_file)
);

create table if not exists content (
	sha256 text primary key,
	byte_count integer not null,
	line_count integer not null,
	encoding text not null,
	line_starts text not null,
	bytes blob not null
);

-- Public generation identities remain stable API values. Child relationships
-- use the narrow integer key.
create table if not exists generation (
	generation_key integer primary key,
	id text not null unique,
	state text not null check (state in ('building', 'published', 'superseded', 'failed')),
	source_hash text not null,
	config_hash text not null,
	input_hash text not null default '',
	started_at text not null,
	completed_at text,
	revision integer not null default 0,
	file_count integer not null default 0,
	symbol_count integer not null default 0,
	occurrence_count integer not null default 0,
	dependency_edge_count integer not null default 0,
	dependency_binding_count integer not null default 0,
	diagnostic_count integer not null default 0,
	scan_ms integer,
	compiler_ms integer,
	extraction_ms integer,
	insertion_ms integer,
	verification_ms integer,
	publication_ms integer,
	error text
);

create table if not exists generation_adapter (
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	revision integer not null default 0,
	protocol_version integer not null default 1,
	adapter_version text not null,
	package_name text,
	package_version text,
	compiler_version text not null,
	declared_compiler_version text,
	compiler_drift integer not null default 0 check (compiler_drift in (0, 1)),
	coverage text not null check (coverage in ('present', 'absent')),
	absence_reason text,
	source_hash text not null,
	config_hash text not null,
	input_hash text not null default '',
	file_count integer not null default 0,
	symbol_count integer not null default 0,
	occurrence_count integer not null default 0,
	dependency_edge_count integer not null default 0,
	dependency_binding_count integer not null default 0,
	diagnostic_count integer not null default 0,
	scan_ms integer,
	compiler_ms integer,
	extraction_ms integer,
	primary key (generation_key, adapter_id)
);

create table if not exists project_context (
	context_key integer primary key,
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	name text not null,
	project_file text not null,
	config_hash text not null,
	unique (generation_key, adapter_id, name)
);

create table if not exists file (
	file_key integer primary key,
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	path text not null,
	sha256 text not null,
	content_sha256 text references content(sha256),
	line_count integer not null,
	unique (generation_key, path)
);

create index if not exists file_by_content on file (content_sha256);
create index if not exists file_by_adapter on file (generation_key, adapter_id, path);

create table if not exists generation_file_digest (
	file_key integer primary key references file(file_key) on delete cascade,
	adapter_id text not null,
	digest text not null
);

create index if not exists generation_file_digest_by_adapter on generation_file_digest (adapter_id, file_key);

create table if not exists symbol (
	symbol_key integer primary key,
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	id text not null,
	name text not null,
	qualified_name text not null,
	kind text not null,
	file_key integer not null references file(file_key) on delete cascade,
	start_line integer not null,
	start_column integer not null,
	end_line integer not null,
	end_column integer not null,
	start_offset integer not null,
	end_offset integer not null,
	enclosing_symbol_key integer references symbol(symbol_key) on delete cascade deferrable initially deferred,
	external_target text,
	external_name text,
	exposure text not null check (exposure in ('published', 'reachable', 'internal_only')),
	unique (generation_key, id)
);

create table if not exists symbol_context (
	symbol_key integer not null references symbol(symbol_key) on delete cascade,
	context_key integer not null references project_context(context_key) on delete cascade,
	primary key (symbol_key, context_key)
);

create table if not exists symbol_name (
	symbol_name_key integer primary key,
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	binding_id text not null,
	symbol_key integer not null references symbol(symbol_key) on delete cascade,
	binding_key text not null check (length(binding_key) > 0),
	container text not null,
	name text not null,
	qualified_name text not null check (length(qualified_name) > 0),
	exposure text not null check (exposure in ('published', 'reachable', 'internal')),
	has_declared_site integer not null check (has_declared_site in (0, 1)),
	unique (generation_key, binding_id),
	unique (symbol_key, binding_key)
);

create table if not exists symbol_name_context (
	symbol_name_key integer not null references symbol_name(symbol_name_key) on delete cascade,
	context_key integer not null references project_context(context_key) on delete cascade,
	exposure text not null check (exposure in ('published', 'reachable', 'internal')),
	primary key (symbol_name_key, context_key)
);

create table if not exists symbol_name_site (
	symbol_name_key integer not null references symbol_name(symbol_name_key) on delete cascade,
	file_key integer not null references file(file_key) on delete cascade,
	kind text not null check (kind in ('declared', 'alias', 'default', 'reexport', 'wildcard', 'commonjs', 'surface')),
	start_line integer not null,
	start_column integer not null,
	end_line integer not null,
	end_column integer not null,
	start_offset integer not null,
	end_offset integer not null check (end_offset > start_offset),
	primary key (symbol_name_key, file_key, start_offset)
);

create table if not exists surface_binding_origin (
	symbol_name_key integer not null,
	context_key integer not null,
	root_symbol_name_key integer not null,
	relative_key text not null check (length(relative_key) > 0),
	primary key (symbol_name_key, context_key),
	foreign key (symbol_name_key, context_key) references symbol_name_context(symbol_name_key, context_key) on delete cascade,
	foreign key (root_symbol_name_key, context_key) references symbol_name_context(symbol_name_key, context_key) on delete cascade
);

create table if not exists occurrence (
	occurrence_key integer primary key,
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	symbol_key integer not null references symbol(symbol_key) on delete cascade,
	file_key integer not null references file(file_key) on delete cascade,
	-- Denormalized only to retain deterministic public ordering without a
	-- join-side sort on the reference hot path.
	path_order text not null,
	symbol_id_order text not null,
	start_line integer not null,
	start_column integer not null,
	end_line integer not null,
	end_column integer not null,
	start_offset integer not null,
	end_offset integer not null,
	role text not null check (role in ('definition', 'reference')),
	enclosing_symbol_key integer references symbol(symbol_key) on delete cascade deferrable initially deferred,
	declaration_kind text,
	forward_definition integer not null default 0 check (forward_definition in (0, 1)),
	usage integer not null default 0 check (usage in (0, 1, 2, 4, 6, 8)),
	extent_start integer,
	extent_end integer,
	anchor_rank integer,
	primary_rank integer,
	unique (symbol_key, path_order, start_offset, role),
	check (
		(role = 'definition'
			and declaration_kind is not null
			and length(declaration_kind) > 0
			and usage = 0
			and extent_start is not null
			and extent_end is not null
			and extent_start <= start_offset
			and extent_end >= end_offset
			and anchor_rank is not null
			and primary_rank is not null)
		or (role = 'reference'
			and declaration_kind is null
			and forward_definition = 0
			and extent_start is null
			and extent_end is null
			and anchor_rank is null
			and primary_rank is null)
	)
);

create table if not exists occurrence_context (
	occurrence_key integer not null references occurrence(occurrence_key) on delete cascade,
	context_key integer not null references project_context(context_key) on delete cascade,
	primary key (occurrence_key, context_key)
);

create table if not exists definition_site (
	definition_site_key integer primary key,
	generation_key integer not null references generation(generation_key) on delete cascade,
	site_id text not null,
	occurrence_key integer not null unique references occurrence(occurrence_key) on delete cascade,
	symbol_key integer not null references symbol(symbol_key) on delete cascade,
	symbol_id_order text not null,
	file_key integer not null references file(file_key) on delete cascade,
	start_offset integer not null,
	first_in_symbol integer not null default 0 check (first_in_symbol in (0, 1)),
	unique (generation_key, site_id)
);

create table if not exists dependency_edge (
	edge_key integer primary key,
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	id text not null,
	context_key integer references project_context(context_key) on delete cascade,
	source_file_key integer not null references file(file_key) on delete cascade,
	target_file_key integer references file(file_key) on delete set null,
	raw_target text not null,
	target_identifier text,
	kind text not null,
	compile_time_only integer not null check (compile_time_only in (0, 1)),
	start_line integer not null,
	start_column integer not null,
	end_line integer not null,
	end_column integer not null,
	start_offset integer not null,
	end_offset integer not null,
	unique (generation_key, id)
);

create table if not exists dependency_binding (
	edge_key integer not null references dependency_edge(edge_key) on delete cascade,
	position integer not null,
	kind text not null,
	imported_name text,
	exported_name text,
	local_name text,
	compile_time_only integer not null check (compile_time_only in (0, 1)),
	primary key (edge_key, position)
);

create table if not exists diagnostic (
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	position integer not null,
	category text not null,
	code integer not null,
	message text not null,
	file_key integer references file(file_key) on delete cascade,
	fallback_path text,
	start_line integer,
	start_column integer,
	primary key (generation_key, adapter_id, position),
	check (file_key is null or fallback_path is null)
);

create table if not exists build_stats (
	generation_key integer not null references generation(generation_key) on delete cascade,
	adapter_id text not null,
	language text not null check (length(language) > 0),
	metric text not null check (length(metric) > 0),
	dim1 text not null,
	dim2 text not null,
	dim3 text not null,
	value integer not null check (value >= 0),
	primary key (generation_key, adapter_id, language, metric, dim1, dim2, dim3)
);

create table if not exists extraction_artifact (
	content_sha256 text not null references content(sha256) on delete cascade,
	artifact_kind text not null,
	extractor_id text not null,
	extractor_version text not null,
	context_hash text not null,
	artifact_json text not null,
	created_at text not null,
	last_used_at text not null,
	primary key (content_sha256, artifact_kind, extractor_id, extractor_version, context_hash)
);

create table if not exists build_lease (
	project_id text primary key,
	owner_id text not null,
	process_id integer not null,
	acquired_at text not null,
	heartbeat_at text not null,
	expires_at text not null
);

create index if not exists symbol_context_by_context on symbol_context (context_key, symbol_key);
create index if not exists symbol_by_path on symbol (generation_key, file_key, start_offset);
create index if not exists symbol_by_adapter on symbol (generation_key, adapter_id, file_key, start_offset);
create index if not exists symbol_by_name on symbol (generation_key, name);
create index if not exists symbol_by_qualified_name on symbol (generation_key, qualified_name);
create index if not exists symbol_by_enclosing on symbol (generation_key, enclosing_symbol_key);

create index if not exists symbol_name_by_name on symbol_name (generation_key, name, container, binding_id, symbol_key, adapter_id, exposure, has_declared_site, qualified_name);
create index if not exists symbol_name_by_qualified_name on symbol_name (generation_key, qualified_name);
create index if not exists symbol_name_by_container_name on symbol_name (generation_key, container, name);
create index if not exists symbol_name_context_by_exposure on symbol_name_context (context_key, exposure, symbol_name_key);
create index if not exists symbol_name_site_by_path on symbol_name_site (file_key, kind, start_offset);
create index if not exists surface_binding_origin_by_root on surface_binding_origin (root_symbol_name_key, context_key);

create index if not exists occurrence_context_by_context on occurrence_context (context_key, occurrence_key);
create index if not exists occurrence_by_path on occurrence (generation_key, file_key, role, start_offset, symbol_key, end_offset);
create index if not exists occurrence_by_adapter on occurrence (generation_key, adapter_id, file_key, role, start_offset);
create index if not exists occurrence_by_extent on occurrence (generation_key, file_key, role, extent_start);
create index if not exists occurrence_by_enclosing on occurrence (generation_key, enclosing_symbol_key);

create index if not exists definition_site_by_path on definition_site (generation_key, file_key, first_in_symbol, start_offset, symbol_id_order);

create index if not exists dependency_by_target_identifier on dependency_edge (generation_key, target_identifier, source_file_key);
create index if not exists dependency_by_target on dependency_edge (generation_key, target_file_key, source_file_key);
create index if not exists dependency_by_source on dependency_edge (generation_key, source_file_key, start_offset);
`;
