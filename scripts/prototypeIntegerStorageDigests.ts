type DigestQueryType = Readonly<{name: string; source: string; prototype: string}>;

export const DIGEST_QUERIES: readonly DigestQueryType[] = [
	{
		name: 'metadata',
		source: `select key, value from source.metadata where key <> 'schema_version' order by key`,
		prototype: `select key, value from metadata where key <> 'schema_version' order by key`,
	},
	{
		name: 'working_copy',
		source: `select id, canonical_root, vcs_kind, vcs_repository, vcs_revision, vcs_relative_root, created_at, last_seen_at
			from source.working_copy order by id`,
		prototype: `select id, canonical_root, vcs_kind, vcs_repository, vcs_revision, vcs_relative_root, created_at, last_seen_at
			from working_copy order by id`,
	},
	{
		name: 'indexed_project',
		source: `select id, working_copy_id, adapter_id, project_file, compiler_version, extractor_version, created_at
			from source.indexed_project order by working_copy_id, adapter_id, project_file`,
		prototype: `select id, working_copy_id, adapter_id, project_file, compiler_version, extractor_version, created_at
			from indexed_project order by working_copy_id, adapter_id, project_file`,
	},
	{
		name: 'content',
		source: `select sha256, byte_count, line_count, encoding, line_starts, bytes from source.content order by sha256`,
		prototype: `select sha256, byte_count, line_count, encoding, line_starts, bytes from content order by sha256`,
	},
	{
		name: 'generation',
		source: `select id, state, source_hash, config_hash, input_hash, started_at, completed_at, revision, file_count,
			symbol_count, occurrence_count, dependency_edge_count, dependency_binding_count, diagnostic_count, scan_ms,
			compiler_ms, extraction_ms, insertion_ms, verification_ms, publication_ms, error
			from source.generation order by id`,
		prototype: `select id, state, source_hash, config_hash, input_hash, started_at, completed_at, revision, file_count,
			symbol_count, occurrence_count, dependency_edge_count, dependency_binding_count, diagnostic_count, scan_ms,
			compiler_ms, extraction_ms, insertion_ms, verification_ms, publication_ms, error
			from generation order by id`,
	},
	{
		name: 'generation_adapter',
		source: `select generation_id, adapter_id, protocol_version, adapter_version, package_name, package_version,
			compiler_version, declared_compiler_version, compiler_drift, coverage, absence_reason, source_hash, config_hash,
			input_hash, file_count, symbol_count, occurrence_count, dependency_edge_count, dependency_binding_count,
			diagnostic_count, scan_ms, compiler_ms, extraction_ms
			from source.generation_adapter order by generation_id, adapter_id`,
		prototype: `select g.id generation_id, a.adapter_id, a.protocol_version, a.adapter_version, a.package_name,
			a.package_version, a.compiler_version, a.declared_compiler_version, a.compiler_drift, a.coverage,
			a.absence_reason, a.source_hash, a.config_hash, a.input_hash, a.file_count, a.symbol_count, a.occurrence_count,
			a.dependency_edge_count, a.dependency_binding_count, a.diagnostic_count, a.scan_ms, a.compiler_ms, a.extraction_ms
			from generation_adapter a join generation g using (generation_key) order by g.id, a.adapter_id`,
	},
	{
		name: 'project_context',
		source: `select generation_id, adapter_id, name, project_file, config_hash
			from source.project_context order by generation_id, adapter_id, name`,
		prototype: `select g.id generation_id, c.adapter_id, c.name, c.project_file, c.config_hash
			from project_context c join generation g using (generation_key) order by g.id, c.adapter_id, c.name`,
	},
	{
		name: 'file',
		source: `select generation_id, adapter_id, path, sha256, content_sha256, line_count
			from source.file order by generation_id, path`,
		prototype: `select g.id generation_id, f.adapter_id, f.path, f.sha256, f.content_sha256, f.line_count
			from file f join generation g using (generation_key) order by g.id, f.path`,
	},
	{
		name: 'generation_file_digest',
		source: `select generation_id, adapter_id, path, digest
			from source.generation_file_digest order by generation_id, path`,
		prototype: `select g.id generation_id, d.adapter_id, f.path, d.digest
			from generation_file_digest d join file f using (file_key) join generation g using (generation_key)
			order by g.id, f.path`,
	},
	{
		name: 'symbol',
		source: `select generation_id, adapter_id, id, name, qualified_name, kind, path, start_line, start_column, end_line,
			end_column, start_offset, end_offset, enclosing_id, external_target, external_name, exposure
			from source.symbol order by generation_id, id`,
		prototype: `select g.id generation_id, s.adapter_id, s.id, s.name, s.qualified_name, s.kind, f.path, s.start_line,
			s.start_column, s.end_line, s.end_column, s.start_offset, s.end_offset, enclosing.id enclosing_id,
			s.external_target, s.external_name, s.exposure from symbol s join generation g using (generation_key)
			join file f using (file_key) left join symbol enclosing on enclosing.symbol_key = s.enclosing_symbol_key
			order by g.id, s.id`,
	},
	{
		name: 'symbol_context',
		source: `select generation_id, adapter_id, symbol_id, context_name
			from source.symbol_context order by generation_id, adapter_id, symbol_id, context_name`,
		prototype: `select g.id generation_id, c.adapter_id, s.id symbol_id, c.name context_name
			from symbol_context sc join symbol s using (symbol_key) join generation g on g.generation_key = s.generation_key
			join project_context c using (context_key) order by g.id, c.adapter_id, s.id, c.name`,
	},
	{
		name: 'symbol_name',
		source: `select generation_id, adapter_id, binding_id, symbol_id, binding_key, container, name, qualified_name,
			exposure, has_declared_site from source.symbol_name order by generation_id, binding_id`,
		prototype: `select g.id generation_id, n.adapter_id, n.binding_id, s.id symbol_id, n.binding_key, n.container, n.name,
			n.qualified_name, n.exposure, n.has_declared_site from symbol_name n join generation g using (generation_key)
			join symbol s using (symbol_key) order by g.id, n.binding_id`,
	},
	{
		name: 'symbol_name_context',
		source: `select generation_id, adapter_id, binding_id, context_name, exposure
			from source.symbol_name_context order by generation_id, adapter_id, binding_id, context_name`,
		prototype: `select g.id generation_id, n.adapter_id, n.binding_id, c.name context_name, nc.exposure
			from symbol_name_context nc join symbol_name n using (symbol_name_key)
			join generation g on g.generation_key = n.generation_key join project_context c using (context_key)
			order by g.id, n.adapter_id, n.binding_id, c.name`,
	},
	{
		name: 'symbol_name_site',
		source: `select generation_id, adapter_id, binding_id, kind, path, start_line, start_column, end_line, end_column,
			start_offset, end_offset from source.symbol_name_site
			order by generation_id, adapter_id, binding_id, path, start_offset`,
		prototype: `select g.id generation_id, n.adapter_id, n.binding_id, site.kind, f.path, site.start_line,
			site.start_column, site.end_line, site.end_column, site.start_offset, site.end_offset
			from symbol_name_site site join symbol_name n using (symbol_name_key)
			join generation g on g.generation_key = n.generation_key join file f using (file_key)
			order by g.id, n.adapter_id, n.binding_id, f.path, site.start_offset`,
	},
	{
		name: 'surface_binding_origin',
		source: `select generation_id, adapter_id, binding_id, context_name, root_binding_id, relative_key
			from source.surface_binding_origin order by generation_id, adapter_id, binding_id, context_name`,
		prototype: `select g.id generation_id, n.adapter_id, n.binding_id, c.name context_name,
			root.binding_id root_binding_id, origin.relative_key
			from surface_binding_origin origin join symbol_name n on n.symbol_name_key = origin.symbol_name_key
			join symbol_name root on root.symbol_name_key = origin.root_symbol_name_key
			join generation g on g.generation_key = n.generation_key join project_context c using (context_key)
			order by g.id, n.adapter_id, n.binding_id, c.name`,
	},
	{
		name: 'occurrence',
		source: `select generation_id, adapter_id, symbol_id, path, start_line, start_column, end_line, end_column,
			start_offset, end_offset, role, enclosing_id, declaration_kind, forward_definition, usage, extent_start,
			extent_end, anchor_rank, primary_rank from source.occurrence
			order by generation_id, symbol_id, path, start_offset, role`,
		prototype: `select g.id generation_id, o.adapter_id, s.id symbol_id, f.path, o.start_line, o.start_column, o.end_line,
			o.end_column, o.start_offset, o.end_offset, o.role, enclosing.id enclosing_id, o.declaration_kind,
			o.forward_definition, o.usage, o.extent_start, o.extent_end, o.anchor_rank, o.primary_rank
			from occurrence o join generation g using (generation_key) join symbol s using (symbol_key)
			join file f using (file_key) left join symbol enclosing on enclosing.symbol_key = o.enclosing_symbol_key
			order by g.id, s.id, f.path, o.start_offset, o.role`,
	},
	{
		name: 'occurrence_context',
		source: `select generation_id, adapter_id, symbol_id, path, start_offset, role, context_name
			from source.occurrence_context order by generation_id, symbol_id, path, start_offset, role, context_name`,
		prototype: `select g.id generation_id, c.adapter_id, s.id symbol_id, f.path, o.start_offset, o.role, c.name context_name
			from occurrence_context oc join occurrence o using (occurrence_key) join generation g on g.generation_key = o.generation_key
			join symbol s on s.symbol_key = o.symbol_key join file f on f.file_key = o.file_key
			join project_context c using (context_key) order by g.id, s.id, f.path, o.start_offset, o.role, c.name`,
	},
	{
		name: 'definition_site',
		source: `select generation_id, adapter_id, site_id, symbol_id, path, start_offset, role, first_in_symbol
			from source.definition_site order by generation_id, adapter_id, site_id`,
		prototype: `select g.id generation_id, o.adapter_id, d.site_id, s.id symbol_id, f.path, o.start_offset, o.role,
			d.first_in_symbol from definition_site d join generation g using (generation_key)
			join occurrence o using (occurrence_key) join symbol s using (symbol_key) join file f using (file_key)
			order by g.id, o.adapter_id, d.site_id`,
	},
	{
		name: 'dependency_edge',
		source: `select generation_id, adapter_id, id, context_name, source_path, target_path, raw_target,
			target_identifier, kind, compile_time_only, start_line, start_column, end_line, end_column, start_offset, end_offset
			from source.dependency_edge order by generation_id, id`,
		prototype: `select g.id generation_id, e.adapter_id, e.id, c.name context_name, source_file.path source_path,
			target_file.path target_path, e.raw_target, e.target_identifier, e.kind, e.compile_time_only, e.start_line,
			e.start_column, e.end_line, e.end_column, e.start_offset, e.end_offset
			from dependency_edge e join generation g using (generation_key)
			join file source_file on source_file.file_key = e.source_file_key
			left join file target_file on target_file.file_key = e.target_file_key
			left join project_context c using (context_key) order by g.id, e.id`,
	},
	{
		name: 'dependency_binding',
		source: `select generation_id, adapter_id, edge_id, position, kind, imported_name, exported_name, local_name,
			compile_time_only from source.dependency_binding order by generation_id, adapter_id, edge_id, position`,
		prototype: `select g.id generation_id, e.adapter_id, e.id edge_id, b.position, b.kind, b.imported_name,
			b.exported_name, b.local_name, b.compile_time_only from dependency_binding b join dependency_edge e using (edge_key)
			join generation g using (generation_key) order by g.id, e.adapter_id, e.id, b.position`,
	},
	{
		name: 'diagnostic',
		source: `select generation_id, adapter_id, position, category, code, message, path, start_line, start_column
			from source.diagnostic order by generation_id, adapter_id, position`,
		prototype: `select g.id generation_id, d.adapter_id, d.position, d.category, d.code, d.message,
			coalesce(f.path, d.fallback_path) path,
			d.start_line, d.start_column from diagnostic d join generation g using (generation_key)
			left join file f using (file_key) order by g.id, d.adapter_id, d.position`,
	},
	{
		name: 'build_stats',
		source: `select generation_id, adapter_id, language, metric, dim1, dim2, dim3, value
			from source.build_stats order by generation_id, adapter_id, language, metric, dim1, dim2, dim3`,
		prototype: `select g.id generation_id, s.adapter_id, s.language, s.metric, s.dim1, s.dim2, s.dim3, s.value
			from build_stats s join generation g using (generation_key)
			order by g.id, s.adapter_id, s.language, s.metric, s.dim1, s.dim2, s.dim3`,
	},
	{
		name: 'extraction_artifact',
		source: `select content_sha256, artifact_kind, extractor_id, extractor_version, context_hash, artifact_json,
			created_at, last_used_at from source.extraction_artifact
			order by content_sha256, artifact_kind, extractor_id, extractor_version, context_hash`,
		prototype: `select content_sha256, artifact_kind, extractor_id, extractor_version, context_hash, artifact_json,
			created_at, last_used_at from extraction_artifact
			order by content_sha256, artifact_kind, extractor_id, extractor_version, context_hash`,
	},
	{
		name: 'build_lease',
		source: `select project_id, owner_id, process_id, acquired_at, heartbeat_at, expires_at
			from source.build_lease order by project_id`,
		prototype: `select project_id, owner_id, process_id, acquired_at, heartbeat_at, expires_at
			from build_lease order by project_id`,
	},
];
