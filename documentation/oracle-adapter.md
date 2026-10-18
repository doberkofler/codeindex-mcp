# Oracle SQL and PL/SQL Adapter

**Status:** planned

## 1. Scope

The Oracle adapter indexes SQL and PL/SQL from two independent sources:

- version-controlled source, including undeployed and multi-unit scripts;
- live Oracle metadata and source exposed through a read-only connection.

Neither source is treated as a substitute for the other. Source files remain the
editing target. Live metadata describes deployed state. The adapter never executes
DDL or DML and never reads application table data.

The adapter covers packages, procedures, functions, object types, triggers, views,
anonymous blocks, script fragments, tables, columns, constraints, dependencies,
synonyms, grants needed for resolution, overloads, arguments, and diagnostics.

## 2. Static source extraction

The first parser is a source-unit splitter, not a claim of complete PL/SQL semantic
analysis. It must handle:

- line and block comments;
- normal strings, quoted identifiers, and Oracle alternative quoting;
- SQL*Plus commands and substitution variables;
- lone `/` terminators;
- `CREATE OR REPLACE` units;
- package specifications and bodies;
- procedures, functions, triggers, types, views, DDL, and anonymous blocks;
- files containing multiple units.

Required properties:

- ranges never overlap;
- ranges plus separators reproduce the original bytes;
- one-unit fixtures produce one expected unit;
- multi-unit fixtures preserve every unit and exact range;
- manifest or include entries resolve when that input is configured;
- undeployed units remain queryable and are marked `source_only`;
- parse failures retain path/range evidence and become unresolved sites.

A tokenizer may emit conservative declarations, qualified-name candidates, table
uses, and call candidates. Facts not established by a complete resolver are
heuristic. A full grammar is justified only by measured splitter/tokenizer
failures; adopting ANTLR or another parser is not an architectural prerequisite.

Raw bytes own source identity and ranges. Normalized SQL is never used for source
locations.

## 3. Live dictionary extraction

The live adapter selects a dictionary mode according to proven privileges:

| Mode | Use |
| --- | --- |
| `USER_*` | One connected schema; no owner filter needed |
| `ALL_*` | Objects visible to the account; explicit owner scope required |
| `DBA_*` | Explicitly provisioned catalogue access; explicit owner scope required |

Do not assume catalogue roles from deployment documentation. Detect accessible
views and fail with a bounded diagnostic when the configured mode is unavailable.

Required fact sources include:

- objects, types, status, and last DDL time;
- source text and a raw/semantic digest;
- procedures, functions, overload identifiers, and arguments;
- object dependencies;
- synonyms and relevant grants;
- tables, columns, constraints, views, and triggers;
- PL/SQL compiler settings;
- PL/Scope identifiers and statements only when verified present.

Queries stream bounded object batches. Credentials, connection strings, table
values, and unrestricted catalogue data never enter the index or diagnostics.

## 4. Identity and overloads

Oracle symbols require owner, object kind, object name, and routine identity.
Routine names alone are insufficient because packages can overload procedures and
functions. Preserve `SUBPROGRAM_ID`, overload identifier, argument sequence,
position, mode, data type, and default status where available.

Static source and live metadata use separate identities until a mapping is proven.
Synonyms and owner qualification are resolution evidence, not destructive name
normalization.

## 5. PL/Scope gate

PL/Scope is optional evidence. It becomes active only after an experiment against
the exact supported Oracle build demonstrates:

1. representative objects compile with
   `IDENTIFIERS:ALL,STATEMENTS:ALL`;
2. identifier and statement views contain expected calls and SQL statements;
3. overloads and table references agree with sampled source;
4. schema validity and application tests do not regress;
5. compile time and metadata storage growth are acceptable;
6. the normal rebuild path applies settings consistently;
7. wrapped and unsupported units are reported as coverage gaps.

`IDENTIFIERS:ALL` alone is insufficient for SQL-statement facts. An empty
`*_IDENTIFIERS` or `*_STATEMENTS` view means unavailable coverage, not “no calls.”
If the gate fails, retain static and dictionary extraction and label finer-grained
relationships unavailable.

Readiness queries must establish the runtime database version, effective PL/SQL
settings, identifier/statement row availability, overload prevalence, object
validity, and dynamic-SQL prevalence. Store only aggregate readiness results and
bounded diagnostics.

## 6. Source and database drift

Mapping, equality, and direction are separate decisions.

| State | Meaning |
| --- | --- |
| `in_sync` | One source unit and one live object have equal semantic digests |
| `source_only` | One unambiguous source unit exists; no live object exists |
| `db_only` | One live object exists; no source unit maps to it |
| `db_ahead` | Deployment provenance proves a later independent database change |
| `diverged` | Both exist and differ; direction is not proven |
| `unknown` | Source, live text, normalization, or privileges are insufficient |
| `ambiguous_mapping` | More than one plausible source unit or live object exists |

There is no `db_behind` conclusion from repository revision or timestamps alone.
Direction requires deployment provenance.

Comparison procedure:

1. map configured owner, object name, and object kind;
2. reject multiple candidates as `ambiguous_mapping`;
3. calculate source and live semantic digests with the same recorded normalization
   version;
4. compare digests;
5. consult deployment provenance only for direction;
6. attach raw locators and normalization metadata as evidence.

Normalization may account for BOMs, line endings, `CREATE OR REPLACE`, owner
qualification, and SQL*Plus terminators. It must be versioned and must not alter
raw source identity.

## 7. Deployment provenance

Optional deployment evidence is captured at the shared SQL execution boundary,
not inferred from file timestamps. A record may contain:

- repository identity and repository-relative source path;
- source revision or mixed-revision state;
- raw source digest;
- target database/schema identity;
- objects observed before and after execution;
- execution time, result, and run identifier.

The index consumes provenance; it does not perform deployment. Provenance without
a matching source digest cannot establish drift direction.

## 8. Dynamic SQL and unresolved facts

Dynamic SQL, data-driven dispatch, conditional compilation, generated source,
database links, editioning, and wrapped units can prevent exact resolution. The
adapter records the site, reason, candidates, evidence, and coverage impact. It
never upgrades a textual name match to an exact dependency.

Runtime collection is deferred until static unresolved sites are measured and
ranked. If introduced, it may retain endpoint/object names, source locators, and
aggregate counts but must discard values, SQL text, headers, credentials, and
application data before persistence.

## 9. Publication checks

Before publishing an Oracle generation:

- every live routine belongs to one live object and one symbol;
- every source-derived object maps to one unit or an explicit unresolved record;
- all ranges refer to the generation's exact raw content;
- every relationship has evidence;
- owner scoping is explicit for `ALL_*` and `DBA_*` modes;
- ambiguous mappings remain visible;
- unavailable PL/Scope coverage is not represented as complete;
- no database write occurred.

## 10. Logical fact model

The adapter emits language-neutral symbols and edges plus Oracle-specific facts:

| Fact | Contents |
| --- | --- |
| Source unit | File content digest, unit digest, kind, owner/name candidate, exact range |
| Oracle context | Database identity, owner scope, edition, version, privilege mode, PL/Scope settings |
| Oracle object | Owner, name, kind, status, last DDL time, live source digest |
| Routine | Parent object, routine name, subprogram/overload identity, authorization mode |
| Argument | Routine, sequence, position, name, direction, type, default status |
| Dependency | Source object, target owner/name/kind, dependency kind, database link |
| Synonym | Owner/name, target owner/name, optional database link |
| Schema structure | Tables, columns, constraints, views, and triggers needed for navigation |
| PL/Scope fact | Identifier or statement location and resolved usage when available |
| Drift observation | Source unit, live object, state, normalization version, evidence |
| Deployment provenance | Source digest/revision, target context, object set, result, run identity |

Published facts carry one generation identifier. Cached parser output is not a
query surface and cannot be joined across incompatible contexts.

Provisional query capabilities are object/routine lookup, declarations and source,
arguments, dependencies, schema-object references, PL/Scope coverage, unresolved
sites, and drift. Final MCP tool names are fixed only when their bounded schemas
are implemented and protocol-tested.

## 11. Acceptance gates

- all splitter corpus invariants pass;
- sampled source/live mappings achieve at least 95% precision;
- exact relationships achieve at least 95% precision with no silent ambiguity;
- every extraction failure is queryable;
- semantic-digest false-positive drift stays below 5% on a reviewed sample;
- every direction claim has deployment evidence;
- extraction is read-only and bounded in time, memory, and stored source.

See [Roadmap](./roadmap.md) for delivery order.
