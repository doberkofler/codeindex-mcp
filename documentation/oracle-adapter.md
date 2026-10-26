# Oracle SQL and PL/SQL Adapter

**Status:** static O1 adapter implemented and bound to the structural parser
(`structural@5`). The semantic release gate is contract `oracle-o1@4`
([Oracle O1 qualification contract](./oracle-qualification-contract.md)); the
qualification command executes it directly. The current production verdict is
**PASS**: the 2026-10-27 contract recomputation of the 2026-10-25 source
snapshot passes declarations, reference precision and recall, and package
dependency precision and recall. Contract `@4` records the 103
`compiler_inferred_dependency` exclusions decided in
[#101](https://github.com/doberkofler/codeindex-mcp/issues/101). The 2026-10-26
bundle (`oracle-o1@3`), the 2026-10-25 bundle (`oracle-o1@2`, truth policy `v4`),
the 2026-10-19 Oracle-backed run, and the Phase 6/Phase 8 comparisons are
historical evidence, not the current verdict. The controlled 10-case corpus
passed under `oracle-o1@2` and is retained as historical evidence
([controlled evidence](../benchmark/oracle-controlled/README.md)); the
production replacement evidence is the current bundle
([production evidence](../benchmark/oracle-production-20261027/README.md)).

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

Stored symbols use these kinds:

`package`, `procedure`, `function`, `variable`, `constant`, `cursor`,
`ref_cursor_type`, `record_type`, `collection_type`, `subtype`, `exception`, `field`.

Parameters and routine-local declarations are ephemeral. They participate in
resolution but are never persisted or searchable. Nested named routines remain
stored as internal symbols.

Package specifications own canonical public-member symbols. A matching package
body adds definition occurrences for those symbols instead of creating duplicate
public symbols. Private body declarations own new symbols at their body
locations. Overloads remain distinct.

Specification and body routines and cursors pair only when their complete
normalized headings match apart from whitespace, parameter default clauses, and
an explicit lone `IN`. Parameter defaults are ignored because Oracle permits a
specification default to be omitted from the body; a lone `IN` is ignored because
it is the default mode. Names, `OUT`/`IN OUT` modes, types, order, return types,
and routine modifiers remain significant. Ambiguous candidates and missing
bodies produce pairing diagnostics; an unmatched body declaration remains
private. A cursor fully defined in its package specification needs no body, and
`TYPE ... IS REF CURSOR` is `ref_cursor_type`, not a callable cursor.
Package-body private forwards pair with their full implementation, which owns
identity and the primary definition.

Canonical names use `SCHEMA.PACKAGE.MEMBER`. Unquoted identifiers canonicalize to
uppercase; quoted identifiers preserve exact case and are kept distinct from
unquoted equivalents. Binding display begins with `owner["SCHEMA"]::` and uses the
same canonical spelling.

Every stored declaration emits one lexical binding, one context exposure, and
declared source sites. Specification and standalone declarations are published;
body-only declarations and nested routines are internal. Oracle does not use the
`reachable` exposure.

### 3.1 Canonical identity and exposure

Owner participates in canonical identity and binding keys because a workspace can
span several schemas. Unquoted identifiers canonicalize to uppercase; quoted
identifiers preserve authored spelling and stay distinct from unquoted
equivalents.

Production indexing uses authored source and the structural parser as its only
name source. It does not dereference synonyms. Qualification truth uses
`ALL_PROCEDURES`, `ALL_ARGUMENTS`, and PL/Scope restricted to the frozen
`(OWNER, OBJECT_NAME)` inventory. `CURRENT_SCHEMA` resolves unqualified names when
Oracle compiles a unit, so the adapter records the manifest or default schema as
the owner segment for unqualified declarations and preserves explicit qualifiers.
A synonym target is never expanded into a different owner or name.

Matching is exact on the persisted canonical spelling. An unquoted query
canonicalizes to uppercase before exact or prefix comparison; a quoted query
preserves its spelling. With `NLS_COMP = BINARY`, unquoted names are compared
without linguistic case folding.

Package members are classified only after whole-generation spec/body pairing,
because exposure is not file-local.

### 3.2 Definition occurrences

| Construct | Definition treatment |
|---|---|
| package specification and body | two definitions; neither forward |
| spec routine or cursor requiring a body | definition + forward |
| body full routine or cursor | definition |
| package-body private forward | definition + forward |
| call spec or polymorphic table function | definition, not forward |
| spec-only constant, variable, type, exception | definition |

The structural parser records each routine/cursor form: specification
declaration, full definition, package-body forward declaration, call spec, and
polymorphic table function declaration.

Identity and primary-definition selection follow
[Architecture §7.3](./architecture.md#73-symbol-binding-and-exposure-model):
paired spec sites anchor identity, the full body is the primary read site, and a
package anchors on its specification. Parameter defaults and a lone `IN` are
ignored when pairing; names, modes, types, order, return types, and modifiers stay
significant. Ambiguity never silently chooses a target.

Definition extents are the parser's declaration range and are not widened to
comments or trivia.

### 3.3 Qualification boundary

PL/Scope is never a runtime dependency. It supplies qualification evidence for
declarations, definitions, references, calls, assignments, and signatures.
Wrapped units provide no PL/Scope data and are reported as a limitation.

- **G-E (pairing):** the frozen baseline of 610 package specifications, 606
  bodies, and 606 pairs remains authoritative. Spec-only packages are not errors
  unless they declare a routine or cursor that is neither a call spec nor a
  polymorphic table function. Every non-exempt spec routine/cursor in a paired
  package has exactly one full body definition, and full normalized headings must
  match.
- **G-C/G-D (usage and references):** zero `call` and `write` mismatches against
  PL/Scope; recall and precision over the policy-visible population must satisfy
  the [qualification contract](./oracle-qualification-contract.md). The contract,
  not this summary, owns the denominators, exclusion reasons, ambiguity rule, and
  thresholds.

Omission categories are persisted as aggregate build statistics or explicit
limitations; none is silently reclassified as complete.

## 4. References

References are emitted only when static resolution proves a target and that target
is stored:

- nested and private declarations;
- package-private and package-public members;
- qualified members of indexed workspace packages;
- record fields reached through a known record type;
- `%TYPE` and `%ROWTYPE` anchors when the target declaration is indexed.

References whose target is ephemeral are dropped. Reference ownership is the
innermost stored definition containing the reference name.

Reference usage bits are `call` for calls, `read` for ordinary reads, `write` for
assignment targets and `OUT` arguments, `read + write` for `IN OUT` arguments, and
`type_ref` for type positions and `%TYPE`/`%ROWTYPE` anchors. Definitions always
use zero.

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
  declarationStorage.ts stored versus ephemeral declaration classes
  symbolTables.ts      heading-gated spec/body and forward pairing
  publicationFacts.ts  lexical bindings, contexts, and declared sites
  resolveReferences.ts static scope, overload, ownership, and usage resolution
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

### 7.1 Current production verdict

The authoritative semantic gate is contract `oracle-o1@4` with truth policy
`v5`; see the
[Oracle O1 qualification contract](./oracle-qualification-contract.md). The
contract owns the truth population, supported identifier types, usage mapping,
every exclusion reason, the ambiguity rule, the thresholds, empty-truth
behavior, the sample bound, and the identities a report must carry.
`qualify:oracle` executes it directly; no post-processing step is part of the
gate. Policy `v5` omits parameters and routine-local declarations as
`ephemeral_declaration`, matching the publication surface, and maps a scalar
`DEFINITION` row to a reference use.

The current production bundle was recomputed on 2026-10-27 from the source
snapshot installed on 2026-10-25: 1,244 files and units, parser `structural@5`,
contract hash `ee83f2ec…`, approval `97c796a2…`. Every gate passes:

| Section | Result | Gate |
|---|---:|---|
| Declarations | 37,151 / 37,170 recall (99.9489%), 100% precision | PASS |
| References | 187,665 / 188,287 recall (99.6697%), 100% precision | PASS |
| Package dependencies | 5,553 / 5,553 recall (100%), 100% precision; 103 counted `compiler_inferred_dependency` exclusions from 5,656 raw edges | PASS |

No reference extra of any class was emitted. The 622 missing references are
classified: 475 routine calls in 14 files whose per-file ambiguity diagnostic
bound was reached, 49 `SELECT … INTO <record>` field writes, 18 member chains on
function results or collection elements, 59 routine-local references inside
anonymous blocks, and 21 routine-local loop iterators. The 103 dependency rows
that failed under `@3` are all compiler-inferred: the authored file never
mentions the target package, and Oracle recorded the edge from a referenced
type, default expression, or nested record field. `@4` omits exactly those rows
with a lexical, adapter-independent test, so dependency recall measures the
edges the source can name. The
[production evidence](../benchmark/oracle-production-20261027/README.md)
records every denominator, exclusion reason, and the comparison with 2026-10-26,
2026-10-25, Phase 6, and Phase 8.

Each report records `contract.id`, `contract.version`, and `contract.hash`, the
parser identity, the corpus source and configuration hashes, the truth-export
SHA-256 values, and per-reason exclusion counts. The denominators can be
reconstructed from the report alone. Disagreement samples are retained
externally; committed reports keep aggregate counts only.

The controlled 10-case corpus passed under `oracle-o1@2` with 41/41
declarations, 35/35 references, and 7/7 dependencies
([controlled evidence](../benchmark/oracle-controlled/README.md)). A rerun
under `@3` failed because the live export selects every object of the four
PL/Scope types in the schema; the bundle is retained as historical evidence and
was not requalified under `@4`.

Retained historical comparisons:

- Production 2026-10-26 (`@3`, policy `v5`, live installed, 1,244 files)
  reported 99.9489% declaration recall, 99.6697% / 100% reference recall and
  precision, and 98.1789% dependency recall. It is superseded by `@4`.
- Production 2026-10-25 (policy `v4`, live installed, 1,244 files) reported
  99.9462% declaration recall, 99.2033% / 99.7298% reference recall and
  precision, and 98.1789% dependency recall. It is not the current contract.
- Phase 6 (2026-10-21, policy `v2`, SVN r78950, 1,237 files) reported 186,742 /
  186,877 references (99.9278%) and 100% precision with an external ambiguity
  removal step. It is not the current contract, corpus, or policy.
- Phase 8 (2026-10-20, parser `structural@1`, policy `v2`) reported 95.5394%
  declaration and 57.4956% reference recall. It is candidate evidence for the
  ANTLR decision, not a production verdict.
- Phase 0 (2026-10-19, policy `v1`) is the adoption baseline.

No historical artifact is rewritten.

Run the comparison without connecting to Oracle:

```bash
pnpm qualify:oracle
```

Verify and replay a retained bundle without connecting to Oracle:

```bash
node dist/cli.mjs oracle-preflight --bundle benchmark/oracle-production-20261027/corpus.json
node dist/cli.mjs oracle-replay --bundle benchmark/oracle-production-20261027/corpus.json
```

The deterministic verification tiers are:

| Command | Scope | Database |
|---|---|---|
| `pnpm test:oracle` | Every `test/oracle*.test.ts` module discovered from disk plus the generic contracts Oracle depends on | none |
| `pnpm test:oracle:bundle` | Preflight and offline replay of the current production bundle | none |
| `pnpm test:oracle:live` | Read-only catalogue inventory and DDL-refusal preflight; skipped unless `CODE_INDEX_ORACLE_LIVE=1` | read-only |

A module named `oracle*.test.ts` must stay database-free; discovery selects it
unconditionally, so a live-database check uses a different module name. The live
tier never applies DDL: an apply still requires a retained plan and its exact
approval hash.

The command reads `CODE_INDEX_ROOT`, `CODE_INDEX_PROJECT_FILE`,
`CODE_INDEX_ORACLE_IDENTIFIERS`, and `CODE_INDEX_ORACLE_DEPENDENCIES`, or accepts
the corresponding `--root`, `--project-file`, `--identifiers`, and
`--dependencies` options. Qualification uses truth policy `v5` by default. Pass
`--truth-policy v1`, `--truth-policy v2`, `--truth-policy v3`, or
`--truth-policy v4` only to replay
retained historical evidence; those policies are not the release contract. Pass
`--units <plan.json>` to reuse the explicit snapshot object mapping from an
approved live plan; this is required when a source filename differs from the
PL/Scope object name. It exits non-zero when any gate fails.

### 7.2 Historical Phase 0 baseline

The frozen Phase 0 baseline used a production sample project and Oracle
19.0.0.0.0 with a session-scoped `PLSCOPE_SETTINGS='IDENTIFIERS:ALL'`. The
qualification corpus contained 1,237 files: 609 package specifications, 605
package bodies, 14 SQL files, and 9 standalone functions. The frozen evidence,
corpus checksums, truth-export hashes, and both reports are recorded in
[`benchmark/oracle-phase0`](../benchmark/oracle-phase0/README.md).

These results are a policy `v1` measurement. They are retained as the adoption
baseline and are not the current production verdict.

| Gate | Result | Required |
| --- | ---: | ---: |
| Declaration recall | 98.3956% | 99.5% |
| Declaration precision | 99.9662% | 100% |
| Reference recall | 58.5206% | 99.5% |
| Reference precision | 99.4259% | 100% |
| Package dependency recall | 98.1734% | 99.5% |
| Package dependency precision | 100% | 100% |

To replay the frozen baseline without a database connection, verify the bundle
first:

```bash
node dist/cli.mjs oracle-preflight --bundle benchmark/oracle-phase0/corpus.json
```

Preflight fails as **NOT READY** while the external root is absent; it opens no
Oracle session. Bundle contents, the recovery record, and the replacement route
are documented in [`oracle-evidence-bundle.md`](./oracle-evidence-bundle.md).
Once it passes, replay with:

```bash
node dist/cli.mjs qualify --extractor oracle \
  --root /path/to/oracle-live/2eb1e36f6ecdada4/workspace \
  --project-file /path/to/oracle-live/2eb1e36f6ecdada4/workspace/manifests/qualification-index.json \
  --identifiers /path/to/oracle-live/2eb1e36f6ecdada4/user-identifiers.csv \
  --dependencies /path/to/oracle-live/2eb1e36f6ecdada4/user-dependencies.csv \
  --units /path/to/oracle-live/2eb1e36f6ecdada4/plan.json \
  --truth-policy v1 \
  --output /tmp/oracle-qualification.json
```

### 7.3 Historical Phase 0 comparison detail

Excluded from the frozen Phase 0 snapshot:

- 3 installed objects without usable source in the snapshot;
- source-only objects that were not installed in the database (not selected);
- wrapped source, which remains outside O1 scope.

The Phase 0 comparison excluded 63,076 PL/Scope references to package qualifiers
because O1 represents those as dependency edges, not symbol occurrences. It also
rejected PL/Scope rows whose declaration position did not contain the declared
identifier; this removes `SELECT *` column pseudo-declarations and same-line
`CREATE OR REPLACE` column offsets. PL/Scope references whose `ITERATOR` type is
outside the policy `v1` supported set are excluded by that policy; pragma names,
implicit loop iterators, type positions, static SQL, and savepoint names are not
emitted as references. They are not removed merely to raise precision.

Literal `$IF TRUE` and `$IF FALSE` branches are evaluated during tokenization.
Non-literal conditions keep both branches because O1 does not evaluate session
or compilation parameters.

Remaining reference gaps are concentrated in identifiers inside static SQL,
record/object-type member chains whose final member is not indexed, and
parameters or locals used only in those contexts. These are scope gaps, not
formatting noise.

Qualification evidence is split by size. The frozen corpus manifest, per-file
checksums, unit mapping, benchmark, qualification report, and replay commands
are checked in under [`benchmark/oracle-phase0`](../benchmark/oracle-phase0/README.md).
The source snapshot and CSV exports remain external.

Performance measurement is separate:

```bash
CODE_INDEX_ROOT=/path/to/oracle/workspace \
CODE_INDEX_PROJECT_FILE=/path/to/oracle/workspace/oracle-index.json \
pnpm benchmark:oracle:corpus
```

It runs the normal `benchmark` command with the Oracle extractor and never
connects to Oracle.

[`benchmark/oracle-performance`](../benchmark/oracle-performance/README.md)
retains the structural@5 production baseline for the frozen 2026-10-25 corpus:
cold build, warm reuse, one-file edit-to-fresh, full rebuild, representative
queries, peak RSS, CPU, storage, and bundle size. Thresholds were declared
before the first measurement and are committed with the aggregate summary.

```bash
pnpm benchmark:oracle:production
```

The harness verifies the frozen bundle first, copies it per repetition so no
checkout is mutated, discards one warmup, and runs five measured repetitions of
the built CLI and worker path. Raw reports stay in the external evidence root;
only the bounded aggregate and hashes are committed. The Phase 7 ANTLR
measurement is not a production baseline.

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
`SYNONYM`, and non-target PL/SQL) in `dependents.sql`. Dependents are ordered
topologically: an object that invalidates another object compiles before it, so a
shared dependent is restored after every predecessor. Dependency cycles collapse
into one depth because no recompilation order can satisfy them. A plan created
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

Apply reports only phase progress: a counted line with an ETA in roughly twenty
steps per phase, phase timings, and total database time. Object names never
appear in the progress output.

`plan/compile.sql` and `plan/dependents.sql` record the exact statements derived
from the approved snapshot. Apply verifies those files and executes the same
statements through the driver session.

Objects that were already invalid before the run are reported in
`baseline-invalid-objects.csv` and in the run output, including which ones were
restored and which remained invalid. They are not attributed to the
qualification run, unless the plan explicitly approved their restoration and
they remain invalid. A dependent recompile error does not stop the run; the
independent invalid-object comparison decides whether restoration failed.

Recompilation is database DDL. It does not replace source, but it can invalidate
dependent objects and discard package state (`ORA-04068`). The command prints
this warning before applying. Plan version 6 invalidates earlier plans that
ordered dependent restoration by discovery depth instead of dependency order.

`oracledb` is a runtime dependency loaded only by live qualification; normal
indexing and MCP operation never load it. All database work, including the
`ALTER ... COMPILE` statements, uses one `oracledb` session. Set
`CODE_INDEX_ORACLE_TIMEOUT_MS` to override the default 600-second per-call
timeout. Credentials are passed to the driver in memory and never written to
the plan, SQL, or evidence files.

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
