# Oracle SQL and PL/SQL Adapter

**Status:** static O1 adapter implemented. An Oracle-backed qualification run on
2026-10-19 did not meet the promotion gates. Performance qualification and
live-database indexing remain pending.

## 1. Scope

O1 indexes Oracle 19c source without opening a database connection. It recognizes:

- package specifications (`.pks`, `.pkg`);
- package bodies (`.pkb`);
- standalone procedures (`.prc`) and functions (`.fnc`);
- `.sql` and `.pls` files when a manifest opts into those extensions and they
  contain units the structural scanner recognizes.

A file may contain multiple units. Trigger and object-type indexing is deferred
even when such statements appear in a scanned file.

Deferred capabilities:

- live database/catalogue metadata and PL/Scope qualification;
- table, view, column, synonym, grant, and database-link lineage;
- triggers and schema object-type specifications/bodies;
- wrapped source and conditional-compilation branch evaluation;
- dynamic SQL and runtime dispatch;
- cross-language edges.

## 2. Manifest

The Oracle extractor requires an explicit `extractor.project` or
`extractor.projects[].project`; it never guesses a manifest filename.

```json
{
	"schemaVersion": 1,
	"dialect": "19c",
	"defaultSchema": "APP",
	"extensions": [".pks", ".pkg", ".pkb", ".prc", ".fnc"],
	"include": ["database/**/*.pks", "database/**/*.pkb", "database/**/*.prc"],
	"exclude": ["**/generated/**"]
}
```

- `schemaVersion` must be `1` and `dialect` must be `"19c"`.
- `defaultSchema` qualifies package targets when source omits a schema.
- `extensions` is optional. It replaces the default `.pks`, `.pkg`, `.pkb`,
  `.prc`, `.fnc` set. Add `.sql` or `.pls` only when those files should be
  published.
- `include` and `exclude` are workspace-relative POSIX globs. Absolute patterns
  and `..` segments are rejected.
- Each manifest is one project context. Multiple manifests remain separate
  contexts in one generation.

```json
{
	"extractor": {
		"id": "oracle",
		"project": "oracle-index.json"
	}
}
```

## 3. Symbols

O1 emits these kinds:

`package`, `procedure`, `function`, `parameter`, `variable`, `constant`,
`cursor`, `record_type`, `collection_type`, `subtype`, `exception`, `field`.

Package specifications own canonical public-member symbols. A matching package
body adds definition occurrences for those symbols and their parameters instead
of creating duplicate public symbols. Private and nested body declarations own
new symbols at their body locations. Overloads remain distinct.

Canonical names use `SCHEMA.PACKAGE.MEMBER`. Unquoted identifiers canonicalize to
uppercase; quoted identifiers preserve exact case and are kept distinct from
unquoted equivalents.

## 4. References

References are emitted only when static resolution proves a target:

- parameters and routine-local declarations, including nested-routine capture;
- nested declarations;
- package-private and package-public members;
- qualified members of indexed workspace packages;
- record fields reached through a known record type;
- `%TYPE` and `%ROWTYPE` anchors when the target declaration is indexed.

Unqualified overload calls resolve by callable kind, canonical name, argument
count, named arguments, and available defaults. Remaining ambiguity produces one
bounded diagnostic and no occurrence. Text inside strings, comments, dynamic SQL,
and declaration names never becomes a reference.

## 5. Dependencies

O1 dependency kinds are `package-call`, `package-reference`, and
`type-reference`. The canonical target is `SCHEMA.PACKAGE`.

- Direct dependency queries select an exact target identifier.
- Dependency impact traverses resolved `targetPath` edges between authored files.
- Workspace package edges resolve to the package specification path, or to the
  body path when no specification is indexed.
- Unresolved external package calls remain directly queryable as
  `SCHEMA.PACKAGE` using the manifest default schema when source omits a schema.
- Oracle O1 emits no binding rows.

Table and column chains do not become package dependencies. Only calls, indexed
package references, and indexed type anchors produce edges.

## 6. Implementation

```text
src/adapters/oracle/
  tokenize.ts          ANTLR lexer -> compact serializable tokens
  tokenCursor.ts       visible-token navigation and block recovery
  parseUnits.ts        per-file structural parser entry point
  parseDeclarations.ts top-level, package, routine, and member orchestration
  parseMembers.ts      parameters, types, cursors, values, record fields
  scopeGraph.ts        canonical names and callable signatures
  symbolTables.ts      spec/body linkage and declaration bindings
  resolveReferences.ts static scope and overload resolution
  extractDependencies.ts package dependency edges
  manifest.ts          validated manifest and deterministic discovery
  scanProject.ts       source manifest, hashes, and extractor identity
  index.ts             adapter composition
  generated/           pinned ANTLR lexer output
```

Lexing and parsing are per file. ANTLR token streams are converted to compact
records and released before the next file; compiler objects never enter
extraction facts. The generated lexer and its base class are excluded from
authored formatting and linting but still participate in TypeScript compilation.

Grammar provenance and local adaptations are recorded in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Regenerate with:

```bash
pnpm grammar:oracle:download
pnpm grammar:oracle:generate
```

## 7. Qualification status

The first Oracle-backed run used a production sample project and Oracle
19.0.0.0.0 with a session-scoped `PLSCOPE_SETTINGS='IDENTIFIERS:ALL'`. The
qualification corpus contained 1,183 files: 592 package specifications, 588
package bodies, and 3 standalone functions.

| Gate | Result | Required |
| --- | ---: | ---: |
| Declaration recall | 98.44% | 99.5% |
| Declaration precision | 99.96% | 100% |
| Reference recall | 59.06% | 99.5% |
| Reference precision | 99.16% | 100% |
| Package dependency recall | 98.14% | 99.5% |
| Package dependency precision | 100% | 100% |

Run the comparison without connecting to Oracle:

```bash
pnpm qualify:oracle
```

The command reads `CODE_INDEX_ROOT`, `CODE_INDEX_PROJECT_FILE`,
`CODE_INDEX_ORACLE_IDENTIFIERS`, and `CODE_INDEX_ORACLE_DEPENDENCIES`, or accepts
the corresponding `--root`, `--project-file`, `--identifiers`, and
`--dependencies` options. It exits non-zero when any gate fails.

Performance measurement is separate:

```bash
CODE_INDEX_ROOT=/path/to/oracle/workspace \
CODE_INDEX_PROJECT_FILE=/path/to/oracle/workspace/oracle-index.json \
pnpm benchmark:oracle:corpus
```

It runs the normal `benchmark` command with the Oracle extractor and never
connects to Oracle.

Excluded from the corpus:

- 7 source-only packages absent from the database;
- 2 wrapped `ODS_SYS_Encryption` files;
- 2 deployment scripts that also create a view or object types;
- 1 package whose source references a missing dependency and whose existing
  database source was restored.

The comparison excluded 61,492 PL/Scope references to package qualifiers because
O1 represents those as dependency edges, not symbol occurrences. It also
rejected PL/Scope rows whose declaration position did not contain the declared
identifier; this removes `SELECT *` column pseudo-declarations and same-line
`CREATE OR REPLACE` column offsets. The remaining reference extras are
classified in the external Phase 9 evidence: 377 are PL/Scope references whose
`ITERATOR` type is outside the gate's supported set, 467 are `PRAGMA INLINE`
arguments, 98 are implicit loop iterators typed as declarations, and the rest
are type positions, static SQL, expression references, or residual nested-block
declarations. They are not removed merely to raise precision.

Literal `$IF TRUE` and `$IF FALSE` branches are evaluated during tokenization.
Non-literal conditions keep both branches because O1 does not evaluate session
or compilation parameters.

Remaining reference gaps are concentrated in identifiers inside static SQL,
record/object-type member chains whose final member is not indexed, and
parameters or locals used only in those contexts. These are scope gaps, not
formatting noise.

Qualification evidence, including corpus checksums, exports, and the comparison
script, is stored outside the repository. The adapter is not promoted, and the
gates must be re-run after the reference scope is extended or explicitly
redefined.

### Live qualification

`qualify:oracle:live` runs the complete Oracle workflow without storing project
paths or credentials in the repository:

```bash
pnpm qualify:oracle:live --root /path/to/oracle/project
```

The command generates an external manifest for every supported O1 source file
under the root, including `.sql` package scripts, freezes the source, writes
`backup.sql`, `baseline.sql`, `compile.sql`, `dependents.sql`, `validate.sql`,
`identifiers.sql`, and `dependencies.sql`, and prints an approval hash. When
credentials are present, it performs a read-only `oracledb` inventory of the
complete `USER_SOURCE` text and the schema's `USER_DEPENDENCIES` edges; no DDL
runs before approval. Planning lexes every candidate file into individual
package, package-body, function, and procedure units, groups them by object, and
selects the candidate whose normalized source is exactly the installed source.
Candidate files that cannot be proven to match abort planning before an approval
is written, and the error lists their workspace-relative paths and normalized
hashes. Multiple identical matches are recorded in the plan. Installed objects
with no candidate file and wrapped installed objects are excluded from the
snapshot, and `compile.sql` contains only `ALTER ... COMPILE` statements for the
remaining installed objects. It never runs authored `CREATE OR REPLACE` scripts.

Planning also computes the transitive non-target dependents of every compiled
object and binds an ordered `ALTER ... COMPILE` statement for each supported
dependent type (`VIEW`, `MATERIALIZED VIEW`, `TRIGGER`, `TYPE`, `TYPE BODY`,
`SYNONYM`, and non-target PL/SQL) in `dependents.sql`. Direct dependents precede
their dependents so nested views are restored in dependency order. A plan created
without a database connection records that dependencies were not checked and
contains an empty `dependents.sql`.

The plan prints a database-change warning with the target schema. Review the
generated SQL, then apply the same plan:

```bash
ORACLE_SERVER=<connect-identifier> \
ORACLE_USER=<user> \
ORACLE_PASSWORD=<password> \
pnpm qualify:oracle:live --root /path/to/oracle/project --approval <hash>
```

The generated manifest uses `ORACLE_USER` as its default schema. Use `--schema`
to override it, `--manifest` to supply an existing manifest, and `--output` to
choose the evidence directory. The default output directory is outside the
source checkout under the CodeIndex data directory. Apply does not re-read the
source checkout; it verifies and uses the frozen snapshot.

The frozen snapshot contains one file per selected unit. A unit that is the only
selected unit from its authored file keeps that file's path; multiple selected
units from one script receive deterministic paths under `units/`. A generated
snapshot manifest includes every frozen unit and never includes unselected units
from a multi-unit script. Each plan unit records its authored source path,
candidate paths, and normalized source hash.

Apply performs these steps:

1. Opens one `oracledb` session and captures the complete invalid-object
   baseline before any DDL in `baseline-invalid-objects.csv`.
2. Backs up `USER_SOURCE` and aborts if any installed object is missing or its
   normalized source hash differs from the approved plan.
3. Recompiles the installed package specifications, package bodies, functions,
   and procedures with `PLSCOPE_SETTINGS='IDENTIFIERS:ALL'`.
4. Recompiles the approved transitive dependents from `dependents.sql`.
5. Validates qualification target PL/SQL separately and fails when a target
   remains invalid.
6. Fails when an approved dependent is still invalid after recompilation.
7. Compares every remaining invalid object with the baseline and fails only when
   an object that was valid before the run is invalid afterwards.
8. Exports `USER_IDENTIFIERS` and `USER_DEPENDENCIES` through the `oracledb`
   session.
9. Rebuilds the snapshot index with the current parser using the plan's unit
   provenance.
10. Compares facts and writes `oracle-qualification.json` and `run.json`.

Objects that were already invalid before the run are reported in
`baseline-invalid-objects.csv` and in the run output, including which ones were
restored and which remained invalid. They are not attributed to the
qualification run, unless the plan explicitly approved their restoration and
they remain invalid. A dependent recompile error does not stop the script; the
independent invalid-object comparison decides whether restoration failed.

Recompilation is database DDL. It does not replace source, but it can invalidate
dependent objects and discard package state (`ORA-04068`). The command prints
this warning before applying. Plan version 5 invalidates earlier plans that did
not bind a dependent-recompilation script or a pre-DDL invalid-object baseline.

`oracledb` is an optional dependency used only by live qualification; normal
indexing and MCP operation never load it. SQL*Plus is retained only because it
already handles Oracle script terminators and SQL*Plus directives in authored
source. Set `CODE_INDEX_ORACLE_SQLPLUS` when `sqlplus` is not on `PATH`, and
`CODE_INDEX_ORACLE_SQLPLUS_TIMEOUT_MS` to override the default 600-second
compile timeout. SQL*Plus receives its connection over standard input; the
`oracledb` session receives credentials directly in memory.

Use a dedicated qualification schema that contains only the snapshot corpus.
The workflow recompiles objects but does not drop unrelated ones; a leftover
object produces an unmapped PL/Scope row and fails qualification. The command
refuses an output directory inside the indexed workspace and never writes
credentials to the plan, SQL, or evidence files.

## 8. Limitations

- Static source only; deployed state and drift are not evaluated.
- SQL object lineage, triggers, object types, synonyms, and database links are
  deferred.
- Conditional-compilation branches are evaluated only for literal `TRUE` and
  `FALSE` conditions; non-literal conditions keep both branches.
- Wrapped units are reported and skipped.
- The adapter does not validate Oracle syntax beyond the tolerant structural
  scanner. Malformed declarations recover at the next declaration or unit
  boundary and produce bounded diagnostics.
