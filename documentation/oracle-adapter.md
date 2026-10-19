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
