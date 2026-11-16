import {createHash} from 'node:crypto';
import {type DatabaseSync} from 'node:sqlite';
import {type VariantType} from './prototypeIntegerStorageSql.ts';

type SqlValueType = null | number | bigint | string | Uint8Array;
type QueryParameterType = number | string;

type QueryDefinitionType = Readonly<{
	name: string;
	sql: string;
	parameters: readonly QueryParameterType[];
	sourceSql: string;
	sourceParameters: readonly QueryParameterType[];
}>;
type QueryEvidenceType = Readonly<{
	name: string;
	plan: readonly string[];
	sourceDigest: string;
	prototypeDigest: string;
	matchesSchema18: boolean;
	rows: number;
	coldP50Ms: number;
	coldP95Ms: number;
	coldMaxMs: number;
	warmP50Ms: number;
	warmP95Ms: number;
	warmMaxMs: number;
}>;
type QuerySeedsType = Readonly<{
	generationKey: number;
	generationId: string;
	adapterId: string;
	symbolKey: number;
	symbolId: string;
	fileKey: number;
	path: string;
	contextName: string;
	bindingId: string;
	bindingName: string;
	edgeId: string;
	dependencyIdentifier: string;
	dependencyTargetFileKey: number;
	dependencyTargetPath: string;
}>;
const appendValue = (hash: ReturnType<typeof createHash>, value: SqlValueType): void => {
	if (value === null) {
		hash.update('null:');
	} else if (value instanceof Uint8Array) {
		hash.update(`blob:${String(value.byteLength)}:`);
		hash.update(value);
	} else {
		const text = String(value);
		hash.update(`${typeof value}:${String(Buffer.byteLength(text))}:${text}`);
	}
	hash.update(';');
};

export const digestRows = (
	statement: ReturnType<DatabaseSync['prepare']>,
	parameters: readonly (number | string)[] = [],
): Readonly<{rows: number; sha256: string}> => {
	const hash = createHash('sha256');
	let rows = 0;
	for (const row of statement.iterate(...parameters)) {
		for (const [key, value] of Object.entries(row)) {
			appendValue(hash, key);
			appendValue(hash, value);
		}
		hash.update('\n');
		rows += 1;
	}
	return {rows, sha256: hash.digest('hex')};
};

const percentile = (values: readonly number[], ratio: number): number => {
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)] ?? 0;
};

const requiredRow = (row: Readonly<Record<string, SqlValueType>> | undefined, message: string): Readonly<Record<string, SqlValueType>> => {
	if (row === undefined) {
		throw new Error(message);
	}
	return row;
};

const numberField = (row: Readonly<Record<string, SqlValueType>>, field: string, message: string): number => {
	const value = row[field];
	if (typeof value !== 'number') {
		throw new TypeError(message);
	}

	return value;
};

const stringField = (row: Readonly<Record<string, SqlValueType>>, field: string, message: string): string => {
	const value = row[field];

	if (typeof value !== 'string') {
		throw new TypeError(message);
	}

	return value;
};

const optionalNumberField = (row: Readonly<Record<string, SqlValueType>> | undefined, field: string, fallback: number): number => {
	const value = row?.[field];
	return typeof value === 'number' ? value : fallback;
};

const optionalStringField = (row: Readonly<Record<string, SqlValueType>> | undefined, field: string): string => {
	const value = row?.[field];
	return typeof value === 'string' ? value : '';
};

const querySeeds = (database: DatabaseSync): QuerySeedsType => {
	const generation = requiredRow(
		database.prepare("select generation_key, id from generation where state = 'published' limit 1").get(),
		'Prototype source has no published generation',
	);
	const generationKey = numberField(generation, 'generation_key', 'Prototype generation lacks an integer key');
	const generationId = stringField(generation, 'id', 'Prototype generation lacks a public ID');
	const symbol = requiredRow(
		database
			.prepare(
				`select s.symbol_key, s.id, s.adapter_id, f.file_key, f.path from symbol s join file f using (file_key)
			 where s.generation_key = ? order by (select count(*) from occurrence o where o.symbol_key = s.symbol_key) desc limit 1`,
			)
			.get(generationKey),
		'Prototype source lacks a symbol query seed',
	);
	const binding = requiredRow(
		database.prepare('select binding_id, name from symbol_name where generation_key = ? order by name limit 1').get(generationKey),
		'Prototype source lacks a binding query seed',
	);
	const context = requiredRow(
		database.prepare('select name from project_context where generation_key = ? order by name limit 1').get(generationKey),
		'Prototype source lacks a context query seed',
	);
	const edge = requiredRow(
		database
			.prepare(
				`select e.id from dependency_edge e
				 where e.generation_key = ? and exists (select 1 from dependency_binding b where b.edge_key = e.edge_key)
				 order by e.id limit 1`,
			)
			.get(generationKey),
		'Prototype source lacks a dependency-binding query seed',
	);
	const dependencyIdentifier = database
		.prepare('select target_identifier, target_file_key from dependency_edge where generation_key = ? and target_identifier is not null limit 1')
		.get(generationKey);
	const dependencyTarget = database
		.prepare(
			`select e.target_file_key, target.path from dependency_edge e join file target on target.file_key = e.target_file_key
			 where e.generation_key = ? limit 1`,
		)
		.get(generationKey);

	return {
		generationKey,
		generationId,
		adapterId: stringField(symbol, 'adapter_id', 'Prototype symbol lacks an adapter ID'),
		symbolKey: numberField(symbol, 'symbol_key', 'Prototype symbol lacks an integer key'),
		symbolId: stringField(symbol, 'id', 'Prototype symbol lacks a public ID'),
		fileKey: numberField(symbol, 'file_key', 'Prototype symbol lacks an integer file key'),
		path: stringField(symbol, 'path', 'Prototype symbol lacks a path'),
		contextName: stringField(context, 'name', 'Prototype context lacks a name'),
		bindingId: stringField(binding, 'binding_id', 'Prototype binding lacks an ID'),
		bindingName: stringField(binding, 'name', 'Prototype binding lacks a name'),
		edgeId: stringField(edge, 'id', 'Prototype edge lacks an ID'),
		dependencyIdentifier: optionalStringField(dependencyIdentifier, 'target_identifier'),
		dependencyTargetFileKey: optionalNumberField(dependencyTarget, 'target_file_key', -1),
		dependencyTargetPath: optionalStringField(dependencyTarget, 'path'),
	};
};

const symbolQueryDefinitions = (seeds: QuerySeedsType): readonly QueryDefinitionType[] => [
	{
		name: 'index_status',
		sql: `select id, revision, source_hash, config_hash, input_hash, file_count, symbol_count, occurrence_count,
				dependency_edge_count, dependency_binding_count, diagnostic_count from generation where state = 'published'`,
		parameters: [],
		sourceSql: `select id, revision, source_hash, config_hash, input_hash, file_count, symbol_count, occurrence_count,
				dependency_edge_count, dependency_binding_count, diagnostic_count from source.generation where state = 'published'`,
		sourceParameters: [],
	},
	{
		name: 'index_status_adapters',
		sql: `select a.adapter_id, a.protocol_version, a.adapter_version, a.compiler_version, a.coverage, a.source_hash,
				a.config_hash, a.input_hash, a.file_count, a.symbol_count, a.occurrence_count, a.dependency_edge_count,
				a.dependency_binding_count, a.diagnostic_count from generation_adapter a
				where a.generation_key = ? order by a.adapter_id`,
		parameters: [seeds.generationKey],
		sourceSql: `select a.adapter_id, a.protocol_version, a.adapter_version, a.compiler_version, a.coverage, a.source_hash,
				a.config_hash, a.input_hash, a.file_count, a.symbol_count, a.occurrence_count, a.dependency_edge_count,
				a.dependency_binding_count, a.diagnostic_count from source.generation_adapter a
				where a.generation_id = ? order by a.adapter_id`,
		sourceParameters: [seeds.generationId],
	},
	{
		name: 'find_symbol',
		sql: `select n.binding_id, s.id symbol_id, n.adapter_id, n.name, n.container, n.qualified_name, n.exposure, n.has_declared_site
				from symbol_name n join symbol s using (symbol_key)
				where n.generation_key = ? and n.name >= ? and n.name < ? order by n.name, n.container, n.binding_id limit ?`,
		parameters: [seeds.generationKey, seeds.bindingName, `${seeds.bindingName}\uFFFF`, 201],
		sourceSql: `select n.binding_id, n.symbol_id, n.adapter_id, n.name, n.container, n.qualified_name, n.exposure, n.has_declared_site
				from source.symbol_name n where n.generation_id = ? and n.name >= ? and n.name < ?
				order by n.name, n.container, n.binding_id limit ?`,
		sourceParameters: [seeds.generationId, seeds.bindingName, `${seeds.bindingName}\uFFFF`, 201],
	},
	{
		name: 'find_symbol_exact_presence',
		sql: `select distinct n.exposure from symbol_name n
				where n.generation_key = ? and n.name = ? and n.adapter_id = ? order by n.exposure`,
		parameters: [seeds.generationKey, seeds.bindingName, seeds.adapterId],
		sourceSql: `select distinct n.exposure from source.symbol_name n
				where n.generation_id = ? and n.name = ? and n.adapter_id = ? order by n.exposure`,
		sourceParameters: [seeds.generationId, seeds.bindingName, seeds.adapterId],
	},
	{
		name: 'find_symbol_context',
		sql: `select n.binding_id, s.id symbol_id, n.name, c.exposure from symbol_name n
				join symbol s using (symbol_key) join symbol_name_context c using (symbol_name_key)
				join project_context pc using (context_key)
				where n.generation_key = ? and n.name >= ? and n.name < ? and pc.name = ?
				order by n.name, n.container, n.binding_id limit ?`,
		parameters: [seeds.generationKey, seeds.bindingName, `${seeds.bindingName}\uFFFF`, seeds.contextName, 201],
		sourceSql: `select n.binding_id, n.symbol_id, n.name, c.exposure from source.symbol_name n
				join source.symbol_name_context c on c.generation_id = n.generation_id and c.binding_id = n.binding_id
				where n.generation_id = ? and n.name >= ? and n.name < ? and c.context_name = ?
				order by n.name, n.container, n.binding_id limit ?`,
		sourceParameters: [seeds.generationId, seeds.bindingName, `${seeds.bindingName}\uFFFF`, seeds.contextName, 201],
	},
];

const outlineQueryDefinitions = (seeds: QuerySeedsType, variant: VariantType): readonly QueryDefinitionType[] => [
	{
		name: 'outline',
		sql:
			variant === 'ordered'
				? `select s.id symbol_id, d.start_offset from definition_site d join symbol s using (symbol_key)
						where d.generation_key = ? and d.file_key = ? and d.first_in_symbol = 1
						order by d.start_offset, d.symbol_id_order limit ? offset ?`
				: `select s.id symbol_id, o.start_offset from definition_site d join occurrence o using (occurrence_key)
						join symbol s on s.symbol_key = o.symbol_key
						where d.generation_key = ? and o.file_key = ? and d.first_in_symbol = 1
						order by o.start_offset, o.symbol_key limit ? offset ?`,
		parameters: [seeds.generationKey, seeds.fileKey, 201, 0],
		sourceSql: `select d.symbol_id, d.start_offset from source.definition_site d
				where d.generation_id = ? and d.path = ? and d.first_in_symbol = 1
				order by d.start_offset, d.symbol_id limit ? offset ?`,
		sourceParameters: [seeds.generationId, seeds.path, 201, 0],
	},
	{
		name: 'outline_reexports',
		sql: `select n.binding_id, s.id symbol_id, n.adapter_id, n.name, n.qualified_name, site.kind, f.path,
				site.start_offset, site.end_offset from symbol_name_site site join symbol_name n using (symbol_name_key)
				join symbol s using (symbol_key) join file f using (file_key)
				where n.generation_key = ? and f.path = ?
				and site.kind in ('alias', 'default', 'reexport', 'wildcard')
				order by f.path, site.start_offset, n.name`,
		parameters: [seeds.generationKey, seeds.path],
		sourceSql: `select n.binding_id, n.symbol_id, n.adapter_id, n.name, n.qualified_name, site.kind, site.path,
				site.start_offset, site.end_offset from source.symbol_name_site site
				join source.symbol_name n on n.generation_id = site.generation_id and n.binding_id = site.binding_id
				where site.generation_id = ? and site.path = ?
				and site.kind in ('alias', 'default', 'reexport', 'wildcard')
				order by site.path, site.start_offset, n.name`,
		sourceParameters: [seeds.generationId, seeds.path],
	},
];

const referenceQueryDefinitions = (seeds: QuerySeedsType, variant: VariantType): readonly QueryDefinitionType[] => [
	{
		name: 'find_references',
		sql: `select s.id symbol_id, o.adapter_id, f.path, o.start_offset, o.end_offset, o.start_line, o.start_column,
				o.end_line, o.end_column, o.role, o.usage, enclosing.id enclosing_id
				from occurrence o join symbol s using (symbol_key) join file f using (file_key)
				left join symbol enclosing on enclosing.symbol_key = o.enclosing_symbol_key
				where o.generation_key = ? and o.symbol_key = ?
				order by ${variant === 'ordered' ? 'o.path_order, o.start_offset, o.role, o.symbol_id_order' : 'f.path, o.start_offset, o.role, s.id'}, o.end_offset limit ? offset ?`,
		parameters: [seeds.generationKey, seeds.symbolKey, 201, 0],
		sourceSql: `select o.symbol_id, o.adapter_id, o.path, o.start_offset, o.end_offset, o.start_line, o.start_column,
				o.end_line, o.end_column, o.role, o.usage, o.enclosing_id from source.occurrence o
				where o.generation_id = ? and o.symbol_id = ?
				order by o.path, o.start_offset, o.role, o.symbol_id, o.end_offset limit ? offset ?`,
		sourceParameters: [seeds.generationId, seeds.symbolId, 201, 0],
	},
	{
		name: 'find_reference_groups',
		sql: `select f.path, o.adapter_id, owner.id enclosing_id, o.usage, count(*) occurrence_count
				from occurrence o join file f using (file_key)
				left join symbol owner on owner.symbol_key = o.enclosing_symbol_key
				where o.generation_key = ? and o.symbol_key = ?
				group by f.path, o.adapter_id, o.enclosing_symbol_key, o.usage, owner.id
				order by f.path, owner.id, o.usage`,
		parameters: [seeds.generationKey, seeds.symbolKey],
		sourceSql: `select o.path, o.adapter_id, o.enclosing_id, o.usage, count(*) occurrence_count
				from source.occurrence o where o.generation_id = ? and o.symbol_id = ?
				group by o.path, o.adapter_id, o.enclosing_id, o.usage order by o.path, o.enclosing_id, o.usage`,
		sourceParameters: [seeds.generationId, seeds.symbolId],
	},
	{
		name: 'find_reference_group_contexts',
		sql: `select distinct f.path, o.adapter_id, owner.id enclosing_id, c.name context_name
				from occurrence o join file f using (file_key)
				left join symbol owner on owner.symbol_key = o.enclosing_symbol_key
				join occurrence_context oc using (occurrence_key) join project_context c using (context_key)
				where o.generation_key = ? and o.symbol_key = ? order by f.path, owner.id, c.name`,
		parameters: [seeds.generationKey, seeds.symbolKey],
		sourceSql: `select distinct o.path, o.adapter_id, o.enclosing_id, oc.context_name
				from source.occurrence o join source.occurrence_context oc
				on oc.generation_id = o.generation_id and oc.adapter_id = o.adapter_id and oc.symbol_id = o.symbol_id
				and oc.path = o.path and oc.start_offset = o.start_offset and oc.role = o.role
				where o.generation_id = ? and o.symbol_id = ? order by o.path, o.enclosing_id, oc.context_name`,
		sourceParameters: [seeds.generationId, seeds.symbolId],
	},
];

const readQueryDefinitions = (seeds: QuerySeedsType, variant: VariantType): readonly QueryDefinitionType[] => [
	{
		name: 'read_symbol_summary',
		sql: `select s.id symbol_id, s.name, s.qualified_name, s.kind, s.adapter_id, f.path, s.start_line,
				s.start_column, s.end_line, s.end_column, s.start_offset, s.end_offset, parent.id enclosing_id,
				s.external_target, s.external_name from symbol s join file f using (file_key)
				left join symbol parent on parent.symbol_key = s.enclosing_symbol_key
				where s.generation_key = ? and s.id = ?`,
		parameters: [seeds.generationKey, seeds.symbolId],
		sourceSql: `select s.id symbol_id, s.name, s.qualified_name, s.kind, s.adapter_id, s.path, s.start_line,
				s.start_column, s.end_line, s.end_column, s.start_offset, s.end_offset, s.enclosing_id,
				s.external_target, s.external_name from source.symbol s where s.generation_id = ? and s.id = ?`,
		sourceParameters: [seeds.generationId, seeds.symbolId],
	},
	{
		name: 'read_symbol_definitions',
		sql:
			variant === 'ordered'
				? `select d.site_id, s.id symbol_id, f.path, o.start_offset, o.end_offset, o.start_line, o.start_column,
						o.end_line, o.end_column, o.declaration_kind, o.forward_definition, o.primary_rank, o.anchor_rank,
						o.extent_start, o.extent_end from definition_site d join occurrence o using (occurrence_key)
						join symbol s on s.symbol_key = d.symbol_key join file f on f.file_key = d.file_key
						where d.generation_key = ? and s.id = ?
						order by s.id, o.primary_rank, f.path, o.start_offset, o.end_offset`
				: `select d.site_id, s.id symbol_id, f.path, o.start_offset, o.end_offset, o.start_line, o.start_column,
						o.end_line, o.end_column, o.declaration_kind, o.forward_definition, o.primary_rank, o.anchor_rank,
						o.extent_start, o.extent_end from definition_site d join occurrence o using (occurrence_key)
						join symbol s on s.symbol_key = o.symbol_key join file f on f.file_key = o.file_key
						where d.generation_key = ? and s.id = ?
						order by s.id, o.primary_rank, f.path, o.start_offset, o.end_offset`,
		parameters: [seeds.generationKey, seeds.symbolId],
		sourceSql: `select d.site_id, d.symbol_id, d.path, o.start_offset, o.end_offset, o.start_line, o.start_column,
				o.end_line, o.end_column, o.declaration_kind, o.forward_definition, o.primary_rank, o.anchor_rank,
				o.extent_start, o.extent_end from source.definition_site d join source.occurrence o
				on o.generation_id = d.generation_id and o.symbol_id = d.symbol_id and o.path = d.path
				and o.start_offset = d.start_offset and o.role = 'definition'
				where d.generation_id = ? and d.symbol_id = ?
				order by d.symbol_id, o.primary_rank, d.path, d.start_offset, o.end_offset`,
		sourceParameters: [seeds.generationId, seeds.symbolId],
	},
	{
		name: 'read_symbol_bindings',
		sql: `select n.binding_id, s.id symbol_id, n.name, n.container, n.qualified_name, n.exposure
				from symbol_name n join symbol s using (symbol_key)
				where n.generation_key = ? and s.id = ? order by s.id, n.container, n.name, n.binding_id`,
		parameters: [seeds.generationKey, seeds.symbolId],
		sourceSql: `select n.binding_id, n.symbol_id, n.name, n.container, n.qualified_name, n.exposure
				from source.symbol_name n where n.generation_id = ? and n.symbol_id = ?
				order by n.symbol_id, n.container, n.name, n.binding_id`,
		sourceParameters: [seeds.generationId, seeds.symbolId],
	},
	{
		name: 'read_symbol_binding_contexts',
		sql: `select n.binding_id, c.name context_name, nc.exposure from symbol_name_context nc
				join symbol_name n using (symbol_name_key) join project_context c using (context_key)
				where n.generation_key = ? and n.binding_id = ? order by n.binding_id, c.name`,
		parameters: [seeds.generationKey, seeds.bindingId],
		sourceSql: `select binding_id, context_name, exposure from source.symbol_name_context
				where generation_id = ? and binding_id = ? order by binding_id, context_name`,
		sourceParameters: [seeds.generationId, seeds.bindingId],
	},
	{
		name: 'read_symbol_binding_sites',
		sql: `select n.binding_id, site.kind, f.path, site.start_offset, site.end_offset from symbol_name_site site
				join symbol_name n using (symbol_name_key) join file f using (file_key)
				where n.generation_key = ? and n.binding_id = ? order by n.binding_id, site.kind, f.path, site.start_offset`,
		parameters: [seeds.generationKey, seeds.bindingId],
		sourceSql: `select binding_id, kind, path, start_offset, end_offset from source.symbol_name_site
				where generation_id = ? and binding_id = ? order by binding_id, kind, path, start_offset`,
		sourceParameters: [seeds.generationId, seeds.bindingId],
	},
	{
		name: 'read_file',
		sql: `select f.path, f.sha256, f.line_count, coalesce(c.byte_count, 0) byte_count
				from file f left join content c on c.sha256 = f.content_sha256
				where f.generation_key = ? and f.path = ?`,
		parameters: [seeds.generationKey, seeds.path],
		sourceSql: `select f.path, f.sha256, f.line_count, coalesce(c.byte_count, 0) byte_count
				from source.file f left join source.content c on c.sha256 = f.content_sha256
				where f.generation_id = ? and f.path = ?`,
		sourceParameters: [seeds.generationId, seeds.path],
	},
	{
		name: 'symbol_at',
		sql: `select s.id symbol_id, f.path, o.start_offset, o.end_offset from occurrence o
				join symbol s using (symbol_key) join file f using (file_key)
				where o.generation_key = ? and o.file_key = ? and o.role = 'definition'
				and o.extent_start <= ? and o.extent_end >= ? order by (o.extent_end - o.extent_start), o.start_offset, o.symbol_key`,
		parameters: [seeds.generationKey, seeds.fileKey, Number.MAX_SAFE_INTEGER, 0],
		sourceSql: `select o.symbol_id, o.path, o.start_offset, o.end_offset from source.occurrence o
				where o.generation_id = ? and o.path = ? and o.role = 'definition'
				and o.extent_start <= ? and o.extent_end >= ? order by (o.extent_end - o.extent_start), o.start_offset, o.symbol_id`,
		sourceParameters: [seeds.generationId, seeds.path, Number.MAX_SAFE_INTEGER, 0],
	},
];

const dependencyQueryDefinitions = (seeds: QuerySeedsType): readonly QueryDefinitionType[] => [
	{
		name: 'dependency_identifier',
		sql: `select e.id, source.path source_path, e.start_offset from dependency_edge e join file source on source.file_key = e.source_file_key
				where e.generation_key = ? and e.target_identifier = ? order by source.path, e.start_offset, e.id`,
		parameters: [seeds.generationKey, seeds.dependencyIdentifier],
		sourceSql: `select e.id, e.source_path, e.start_offset from source.dependency_edge e
				where e.generation_id = ? and e.target_identifier = ? order by e.source_path, e.start_offset, e.id`,
		sourceParameters: [seeds.generationId, seeds.dependencyIdentifier],
	},
	{
		name: 'dependency_target',
		sql: `select e.id, source.path source_path, e.start_offset from dependency_edge e join file source on source.file_key = e.source_file_key
				where e.generation_key = ? and e.target_file_key = ? order by source.path, e.start_offset, e.id`,
		parameters: [seeds.generationKey, seeds.dependencyTargetFileKey],
		sourceSql: `select e.id, e.source_path, e.start_offset from source.dependency_edge e
				where e.generation_id = ? and e.target_path = ? order by e.source_path, e.start_offset, e.id`,
		sourceParameters: [seeds.generationId, seeds.dependencyTargetPath],
	},
	{
		name: 'dependency_bindings',
		sql: `select e.id edge_id, b.position, b.kind, b.imported_name, b.exported_name, b.local_name,
				b.compile_time_only from dependency_binding b join dependency_edge e using (edge_key)
				where e.generation_key = ? and e.id = ? order by e.id, b.position`,
		parameters: [seeds.generationKey, seeds.edgeId],
		sourceSql: `select edge_id, position, kind, imported_name, exported_name, local_name, compile_time_only
				from source.dependency_binding where generation_id = ? and edge_id = ? order by edge_id, position`,
		sourceParameters: [seeds.generationId, seeds.edgeId],
	},
];

const queryDefinitions = (seeds: QuerySeedsType, variant: VariantType): readonly QueryDefinitionType[] => [
	...symbolQueryDefinitions(seeds),
	...outlineQueryDefinitions(seeds, variant),
	...referenceQueryDefinitions(seeds, variant),
	...readQueryDefinitions(seeds, variant),
	...dependencyQueryDefinitions(seeds),
];

const evaluateQuery = (database: DatabaseSync, query: QueryDefinitionType): QueryEvidenceType => {
	const statement = database.prepare(query.sql);
	const plan = database
		.prepare(`explain query plan ${query.sql}`)
		.all(...query.parameters)
		.map((row) => String(row['detail']));
	const digest = digestRows(statement, query.parameters);
	const sourceDigest = digestRows(database.prepare(query.sourceSql), query.sourceParameters);
	const cold: number[] = [];
	const warm: number[] = [];

	for (let iteration = 0; iteration < 5; iteration += 1) {
		database.exec('pragma shrink_memory');
		const startedAt = performance.now();
		statement.all(...query.parameters);
		cold.push(performance.now() - startedAt);
	}

	for (let iteration = 0; iteration < 50; iteration += 1) {
		const startedAt = performance.now();
		statement.all(...query.parameters);
		warm.push(performance.now() - startedAt);
	}

	return {
		name: query.name,
		plan,
		sourceDigest: sourceDigest.sha256,
		prototypeDigest: digest.sha256,
		matchesSchema18: sourceDigest.sha256 === digest.sha256,
		rows: digest.rows,
		coldP50Ms: percentile(cold, 0.5),
		coldP95Ms: percentile(cold, 0.95),
		coldMaxMs: Math.max(...cold),
		warmP50Ms: percentile(warm, 0.5),
		warmP95Ms: percentile(warm, 0.95),
		warmMaxMs: Math.max(...warm),
	};
};

export const queryEvidence = (database: DatabaseSync, variant: VariantType): readonly QueryEvidenceType[] => {
	const seeds = querySeeds(database);
	return queryDefinitions(seeds, variant).map((query) => evaluateQuery(database, query));
};
