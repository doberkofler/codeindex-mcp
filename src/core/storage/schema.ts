export const SCHEMA_VERSION = '5';

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
	id text primary key,
	working_copy_id text not null references working_copy(id) on delete cascade,
	project_file text not null,
	compiler_version text not null,
	extractor_id text not null,
	extractor_version text not null,
	created_at text not null,
	unique (working_copy_id, project_file)
);

create table if not exists content (
	sha256 text primary key,
	byte_count integer not null,
	line_count integer not null,
	encoding text not null,
	line_starts text not null,
	bytes blob not null
);

create table if not exists generation (
	id text primary key,
	state text not null check (state in ('building', 'published', 'superseded', 'failed')),
	extractor_id text not null,
	extractor_version text not null,
	compiler_version text not null,
	source_hash text not null,
	config_hash text not null,
	started_at text not null,
	completed_at text,
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

create table if not exists project_context (
	generation_id text not null references generation(id) on delete cascade,
	name text not null,
	project_file text not null,
	config_hash text not null,
	primary key (generation_id, name)
);

create table if not exists file (
	generation_id text not null references generation(id) on delete cascade,
	path text not null,
	sha256 text not null,
	content_sha256 text references content(sha256),
	line_count integer not null,
	primary key (generation_id, path)
);

create table if not exists symbol (
	generation_id text not null references generation(id) on delete cascade,
	id text not null,
	name text not null,
	qualified_name text not null,
	kind text not null,
	path text not null,
	start_line integer not null,
	start_column integer not null,
	end_line integer not null,
	end_column integer not null,
	start_offset integer not null,
	end_offset integer not null,
	enclosing_id text,
	primary key (generation_id, id),
	foreign key (generation_id, path) references file(generation_id, path) on delete cascade
);

create table if not exists symbol_context (
	generation_id text not null,
	symbol_id text not null,
	context_name text not null,
	primary key (generation_id, symbol_id, context_name),
	foreign key (generation_id, symbol_id) references symbol(generation_id, id) on delete cascade,
	foreign key (generation_id, context_name) references project_context(generation_id, name) on delete cascade
);

create index if not exists symbol_context_by_context on symbol_context (generation_id, context_name, symbol_id);
create index if not exists symbol_by_path on symbol (generation_id, path, start_offset);
create index if not exists symbol_by_name on symbol (generation_id, name);
create index if not exists symbol_by_qualified_name on symbol (generation_id, qualified_name);
create table if not exists occurrence (
	generation_id text not null references generation(id) on delete cascade,
	symbol_id text not null,
	path text not null,
	start_line integer not null,
	start_column integer not null,
	end_line integer not null,
	end_column integer not null,
	start_offset integer not null,
	end_offset integer not null,
	role text not null check (role in ('definition', 'reference')),
	enclosing_id text,
	primary key (generation_id, symbol_id, path, start_offset, role),
	foreign key (generation_id, symbol_id) references symbol(generation_id, id) on delete cascade,
	foreign key (generation_id, path) references file(generation_id, path) on delete cascade
);

create table if not exists occurrence_context (
	generation_id text not null,
	symbol_id text not null,
	path text not null,
	start_offset integer not null,
	role text not null check (role in ('definition', 'reference')),
	context_name text not null,
	primary key (generation_id, symbol_id, path, start_offset, role, context_name),
	foreign key (generation_id, symbol_id, path, start_offset, role) references occurrence(generation_id, symbol_id, path, start_offset, role) on delete cascade,
	foreign key (generation_id, context_name) references project_context(generation_id, name) on delete cascade
);

create index if not exists occurrence_context_by_context on occurrence_context (generation_id, context_name, symbol_id);
create table if not exists dependency_edge (
	generation_id text not null references generation(id) on delete cascade,
	id text not null,
	context_name text,
	source_path text not null,
	target_path text,
	raw_specifier text not null,
	normalized_package text,
	kind text not null,
	type_only integer not null check (type_only in (0, 1)),
	start_line integer not null,
	start_column integer not null,
	end_line integer not null,
	end_column integer not null,
	start_offset integer not null,
	end_offset integer not null,
	primary key (generation_id, id),
	foreign key (generation_id, source_path) references file(generation_id, path) on delete cascade
);

create index if not exists dependency_by_package on dependency_edge (generation_id, normalized_package, source_path);
create index if not exists dependency_by_target on dependency_edge (generation_id, target_path, source_path);
create index if not exists dependency_by_source on dependency_edge (generation_id, source_path, start_offset);

create table if not exists dependency_binding (
	generation_id text not null references generation(id) on delete cascade,
	edge_id text not null,
	position integer not null,
	kind text not null,
	imported_name text,
	exported_name text,
	local_name text,
	type_only integer not null check (type_only in (0, 1)),
	primary key (generation_id, edge_id, position),
	foreign key (generation_id, edge_id) references dependency_edge(generation_id, id) on delete cascade
);

create table if not exists diagnostic (
	generation_id text not null references generation(id) on delete cascade,
	position integer not null,
	category text not null,
	code integer not null,
	message text not null,
	path text,
	start_line integer,
	start_column integer,
	primary key (generation_id, position)
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
`;
