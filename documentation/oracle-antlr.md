# Oracle ANTLR Usage

**Status:** production uses the pinned ANTLR lexer plus a tolerant structural
scanner. Phases 1–6 of the implementation plan are now in the repository: the
pinned parser grammar, generated parser and visitor, parser base, an internal
ANTLR parser adapter with conditional-compilation handling and segment
recovery, the declaration visitor, the reference visitor with lexical scope
resolution, the dependency visitor, and qualification policy v2. The adapter is
not wired into production; the structural parser remains authoritative.
Performance and adoption work remain open.

See the [implementation plan](./oracle-antlr-plan.md) for the phased path from
the current adapter to a production decision.

## 1. Why ANTLR Is Used

Oracle SQL and PL/SQL cannot be indexed safely with a regular-expression or
line-based splitter alone. The adapter needs to distinguish:

- strings, comments, quoted identifiers, and alternative-quoted strings;
- package specifications, package bodies, and standalone routines;
- nested blocks, `CASE` expressions, and `END` boundaries;
- conditional-compilation directives;
- SQL and PL/SQL keywords from ordinary identifiers.

The upstream `antlr/grammars-v4` Oracle lexer already solves tokenization for
those cases. The production adapter therefore uses ANTLR for lexing and a
separate structural scanner for declarations and reference sites.

The full parser is a candidate for extending reference and dependency coverage,
especially identifiers inside static SQL, member chains, and package targets.
Production still uses the structural scanner for all parser facts.

## 2. Production Architecture

```text
source text
    │
    ▼
PlSqlLexer.g4  ──► generated PlSqlLexer.ts
    │
    ▼
compact serializable tokens          tokenize.ts
    │
    ▼
visible-token cursor                 tokenCursor.ts
    │
    ▼
structural declaration parser        parseUnits.ts
    │                                parseDeclarations.ts
    │                                parseMembers.ts
    ▼
OracleParseResultType                syntax.ts
    │
    ├── symbols / definition occurrences
    ├── reference sites
    └── dependency sites
```

ANTLR objects do not cross the parser seam. `tokenize.ts` converts the ANTLR
token stream into compact records and releases the lexer, token stream, and
char stream before the next file.

`parseUnits.ts` is the structural parser entry point. It returns the
serializable `OracleParseResultType` consumed by symbol, reference, and
dependency extraction.

## 3. Grammar Provenance

| Item | Value |
| --- | --- |
| Upstream project | `antlr/grammars-v4` |
| Lexer path | `sql/plsql/PlSqlLexer.g4` |
| Parser path | `sql/plsql/PlSqlParser.g4` |
| Pinned commit | `e199816b3f1a7a49ea1ad84fb6b87c382ea36a33` |
| Lexer SHA-256 | `fd82384ba3ba2f5a7b070a977cd77a05c01fefbfb52938d35dfaf472a2e6e59e` |
| Parser SHA-256 | `c57ec1819302de05beb08c44792883e159254e361e8627e981d9a3c99a0b4633` |
| Parser base SHA-256 | `240545ca222036231d7044ce468e2c4ed0d1a0ef6df190cb71a717b47faccfcb` |
| Runtime | `antlr4ng@3.0.16` |
| Generator | `antlr-ng@1.0.10` |
| License | Apache License 2.0 |

`scripts/downloadOracleGrammar.ts` verifies every digest before applying local
adaptations. The generated lexer, generated parser and visitor, and the
upstream-derived base classes are excluded from authored formatting and linting
but still participate in TypeScript compilation. See
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

Regenerate the lexer, parser, and visitor:

```bash
pnpm grammar:oracle:download
pnpm grammar:oracle:generate
```

`pnpm grammar:oracle:generate` is deterministic. `test/oracleGrammar.test.ts`
regenerates into a temporary directory and asserts byte-for-byte equality with
the checked-in artifacts.

## 4. Token Contract

`tokenizeOracleSource(source, path)` returns:

```ts
type OracleTokenType = {
	kind: number;
	text: string;
	channel: 'visible' | 'hidden';
	startOffset: number;
	endOffset: number;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
};
```

Rules:

- Comments and whitespace are retained on the hidden channel so callers can
  decide whether a boundary matters.
- Offsets are UTF-16 half-open ranges. Lines and columns are one-based.
- Lexer errors are bounded and reported through the Oracle diagnostic
  collector.
- The token text concatenation must reconstruct the original source.
- Strings and comments must never become visible tokens.

Literal `$IF TRUE` and `$IF FALSE` branches are evaluated during tokenization.
Non-literal conditions keep both branches because the adapter does not evaluate
session values or compilation parameters.

## 5. Parser Adapter

The ANTLR parser adapter parses each file with the pinned `PlSqlParser.g4`,
converts recovered top-level contexts into `OracleParseResultType`, and keeps
ANTLR parser and tree objects private. Phase 2 emits package and routine units;
Phase 3 adds package and routine members, parameters, variables, constants,
cursors, exceptions, subtypes, record and collection types, fields, and nested
routine scopes. Phase 4 adds reference sites, lexical scopes, nested block and
loop declarations, `%TYPE`/`%ROWTYPE` anchors, static SQL names, overload
arguments, and member chains. Phase 5 adds package dependency sites derived from
qualified references.

The adapter lives in `src/adapters/oracle/antlrParser.ts`; declaration traversal
is owned by `src/adapters/oracle/antlrDeclarations.ts`, reference traversal by
`src/adapters/oracle/antlrReferences.ts`, dependency derivation by
`src/adapters/oracle/antlrDependencies.ts`, SQL qualifier collection by
`src/adapters/oracle/antlrSqlNames.ts`, nested-scope extraction by
`src/adapters/oracle/antlrNestedScopes.ts`, and name, range, and type extraction
by `src/adapters/oracle/antlrDeclarationSupport.ts`. The adapter is exposed as
`parseWithAntlr` / `antlrOracleParser`. Production does not import it yet.

### 5.1 Generation

The parser uses the same pinned grammar commit as the lexer. The parser grammar
needs a local header because the generated TypeScript parser does not infer the
base class import:

```antlr
@header {import {PlSqlParserBase} from "../plSqlParserBase.js";}
```

The base class is vendored from the upstream `Antlr4ng` target and provides:

- `setLastUnitPlsql` / `setLastUnitSql`;
- `isSolidusSeparator`;
- `isVersion10` / `isVersion11` / `isVersion12`;
- `IsNotNumericFunction`;
- `isNotStartOfJoin`.

Generation is owned by `scripts/generateOracleGrammar.ts`:

```bash
pnpm grammar:oracle:generate
```

The generator disables the listener, enables the visitor, and applies only the
deterministic strict-TypeScript post-processing described in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

Generated artifacts:

| Artifact | Size |
| --- | ---: |
| `PlSqlLexer.ts` | 1.2 MB |
| `PlSqlParser.ts` | 12 MB |
| `PlSqlParserVisitor.ts` | 348 KB |
| Parser gzip | ~1.4 MB |

These sizes are not yet acceptable as a production decision. Bundle and startup
cost must be measured on the actual CLI and MCP builds.

### 5.2 Parsing contract

The adapter preserves the existing seam:

```ts
type OracleParseInputType = {
	source: string;
	path: string;
	defaultSchema: string;
};

type OracleParseResultType = {
	units: readonly OracleUnitType[];
	declarations: readonly OracleDeclarationType[];
	references: readonly OracleReferenceSiteType[];
	dependencies: readonly OracleDependencySiteType[];
	diagnostics: readonly DiagnosticType[];
};
```

Additional rules:

- Parse one file at a time.
- Release lexer, parser, token stream, and parse tree before the next file.
- Collect bounded diagnostics; do not emit stack traces or absolute paths.
- Preserve one-based lines and columns and UTF-16 half-open offsets.
- Do not silently merge facts from the structural parser and ANTLR parser.
- Do not fall back automatically from ANTLR to the structural parser. That
  hides recovery failures and makes precision attribution impossible.
- If the whole-file parse reports errors, reparse each SQL*Plus solidus-delimited
  segment in isolation, with the surrounding source blanked, so a malformed unit
  cannot consume later units. This is still ANTLR-only recovery.
- Ambiguous static SQL names remain unresolved rather than guessed.

### 5.3 Conditional compilation

The grammar has `selection_directive` rules, but production sources place
`$IF`/`$THEN`/`$ELSE`/`$END` in contexts the upstream grammar does not always
accept, including SQL expressions and `CASE` branches.

`src/adapters/oracle/conditionalCompilation.ts` removes directive tokens and
literal-disabled branches before parsing:

- `$IF TRUE` and `$IF FALSE` branches are evaluated;
- `$ELSIF` and `$ELSE` chains follow the same literal evaluation;
- non-literal conditions keep both branches;
- every removed byte is replaced with spaces, preserving offsets and line
  numbers;
- unmatched `$IF`, `$ELSIF`, `$ELSE`, `$END`, and `$THEN` emit bounded
  diagnostics rather than truncating the file;
- `$ERROR` is reported and removed.

### 5.4 Declaration facts

`antlrDeclarations.ts` converts the parse tree into the declaration portion of
`OracleParseResultType`. It emits package specifications, package bodies,
standalone routines, package and routine members, parameters, variables,
constants, cursors, exceptions, subtypes, record and collection types, and
record fields. Parent indexes, unit indexes, export flags, overload identity, and
declaration ranges follow the structural parser.

Declaration facts match the structural parser on the committed fixture corpus
apart from symbolic type references. Known intentional differences:

- ANTLR populates declaration and parameter `typeReferences` for symbolic type
  names and `%TYPE`/`%ROWTYPE` anchors. The structural scanner currently emits
  none because `%TYPE` is one lexer token.
- Nested block variables and numeric/cursor loop iterators are emitted as
  `variable` declarations so their uses can resolve. The structural parser does
  not model those scopes.
- `EXTERNAL` and `call_spec` routine tails are not emitted as local
  declarations. The structural scanner can misread those tokens as a variable.
- ANTLR routine ranges cover the complete declaration; the structural parser
  can stop at the token before `IS` or `AS` when it finds no `BEGIN` block.

### 5.5 Reference facts

`antlrReferences.ts` traverses the parse tree and emits a site only for an
authored name occurrence. It never emits declaration names, labels, table or
column aliases, SQL object names, named-argument labels, or package qualifiers
as separate sites.

- Procedural sites cover locals, parameters, constants, exceptions, nested
  routines, calls, named arguments, and member chains.
- Static SQL sites cover expressions in `SELECT`, `INSERT`, `UPDATE`, `DELETE`,
  and `MERGE`, including cursor queries, subqueries, joins, and correlation
  names. Table and column names that do not bind to a known declaration remain
  unresolved rather than guessed.
- `%TYPE` and `%ROWTYPE` anchors produce `type-anchor` sites. Symbolic type
  names also populate declaration `typeReferences`, which the shared resolver
  uses for record, collection, and cursor field chains.
- Each site is assigned to the smallest declaration range containing it, so
  nested routines, variables, cursors, fields, and blocks get the correct
  lexical parent.
- Overload selection, package versus record versus collection chains, nearest
  preceding local shadowing, and collection indexing are handled by the shared
  resolver in `resolveReferences.ts`.
- Ambiguous overloads produce one bounded diagnostic and no occurrence.
  Unresolved names produce neither.

### 5.6 Dependency facts

`antlrDependencies.ts` derives dependency sites from reference sites. A
qualified chain whose first segment resolves to a local declaration is a record,
collection, cursor, or field chain and is excluded. Non-call chains whose first
segment matches a SQL table, table alias, column alias, or query name are also
excluded. The remaining qualified chains follow the structural target slicing:

- two segments target the first segment as a package;
- three or more segments target the first two segments as schema and package.

Package calls, package references, and type references carry the existing
`package-call`, `package-reference`, and `type-reference` kinds. The existing
`extractOracleDependencies` then:

- resolves workspace packages to the specification path, falling back to the
  body path when no specification exists;
- preserves unresolved package calls with a null target path and the configured
  manifest schema in `targetIdentifier`;
- drops unresolved non-call references so table, view, column, and alias chains
  do not become package edges.

`%TYPE` and `%ROWTYPE` anchors produce `type-reference` sites. The structural
scanner currently emits `package-reference` for the same anchor because its
token stream sees `%TYPE` as one token; qualification compares dependency targets
rather than dependency-site kinds. Normal and recovery parses offset dependency
indexes alongside declaration and reference indexes.

## 6. LJS Feasibility Results

> Phase 0 is recorded in [`benchmark/oracle-phase0`](../benchmark/oracle-phase0/README.md).
> The measurements below are historical feasibility results from the earlier
> prototype; the adoption gates remain unverified.

Corpus: `ljs_app` Oracle source, 1,632 `.pks` and `.pkb` files, 24.5 MB.

### 6.1 Raw source

| Metric | Result |
| --- | ---: |
| Files | 1,632 |
| Files with parser errors | 44 (2.7%) |
| Parser errors | 494 |
| Files with lexer errors | 0 |
| Parser crashes | 0 |
| Incomplete parses | 0 |
| p50 parse time | 15 ms |
| p95 parse time | 684 ms |
| p99 parse time | 1,567 ms |
| Max parse time | 5.2 s |

Of the 44 failing files, 24 failed only because of conditional-compilation
directives.

### 6.2 Filtered source

| Metric | Result |
| --- | ---: |
| Files | 1,632 |
| Files parsed cleanly | 1,612 (98.8%) |
| Files with parser errors | 20 (1.2%) |
| Parser errors | 194 |
| Parser crashes | 0 |
| Incomplete parses | 0 |
| p50 parse time | 16 ms |
| p95 parse time | 697 ms |
| p99 parse time | 1,707 ms |
| Max parse time | 5.0 s |
| Total ANTLR parse time | 252.3 s |
| Total structural time | 3.8 s |

The historical ANTLR prototype was approximately **66× slower** than the
structural scanner for this corpus. Peak RSS under Vitest was approximately
**4.1 GB**; that figure includes test-runner and transform overhead and must be
re-measured standalone against the current adapter.

### 6.3 Frozen Phase 0 baseline

The Phase 0 baseline is the 1,237-file LJS snapshot at SVN revision `78950`
with exported PL/Scope truth. It is independent of the historical prototype
numbers above.

| Metric | Structural baseline |
| --- | ---: |
| Declaration recall | 98.3956% |
| Declaration precision | 99.9662% |
| Reference recall | 58.5206% |
| Reference precision | 99.4259% |
| Package dependency recall | 98.1734% |
| Package dependency precision | 100% |
| Cold build | 9,109 ms |
| Warm reuse | 208 ms |
| Warm rebuild | 10,037 ms |
| Peak RSS (cold build) | 2.50 GB |

The corpus manifest, per-file hashes, truth-export hashes, reports, and replay
commands are in [`benchmark/oracle-phase0`](../benchmark/oracle-phase0/README.md).
The baseline does not pass the adoption gates.

### 6.4 Qualification policy v2

Policy `v2` is the current comparison contract; `--truth-policy v1` preserves
the frozen Phase 0 behavior. V2 applies the supported-type map to truth
references as well as actual occurrences, so columns, tables, views, sequences,
datatypes, and labels no longer inflate reference truth. Supported `DEFINITION`
rows are declarations, and `ITERATOR`/`RECORD ITERATOR` map to the extractor's
variable kind. Package references remain excluded because they are dependency
edges.

Every extra fact is classified:

- `omitted_by_policy`: a truth row excluded by the selected policy;
- `location_mismatch`: the same fact at a normalized nearby position;
- `outside_plscope`: a legitimate fact PL/Scope does not record, such as a
  pragma argument;
- `false_positive`: an indexed fact with no truth basis.

Only false positives count against precision; the other classes explain the
disagreement. Metrics are also reported by declaration kind and by reference
construct: procedural, static SQL, member chain, iterator, pragma, and type
anchor. Checked-in golden facts under
`test/fixtures/oracle-qualification-v2/` validate pragma facts that PL/Scope
cannot confirm.

The frozen Phase 0 report remains a `v1` measurement. To reproduce it, pass
`--truth-policy v1`; a default run uses `v2`.

## 7. Known Grammar Gaps

The remaining failures are concentrated in identifiable grammar and lexing
gaps, not arbitrary corruption:

| Construct | Example | Affected area |
| --- | --- | --- |
| `REM` comment with tab | `rem\t***` | SQL*Plus comments |
| Non-reserved keyword as identifier | `date IN VARCHAR2`, `detected BOOLEAN`, `enclosed VARCHAR2` | `regular_id` |
| Constant size in type | `VARCHAR2(kMaxLen CHAR)` | `precision_part` |
| XMLTABLE returning sequence | `RETURNING SEQUENCE BY REF` | XMLTABLE |
| JSON strictness | `IS JSON(STRICT)` | JSON condition |
| SQL*Plus `EXEC` | `EXEC ODS_SYS_InstUtil.DropType(...)` | SQL*Plus command |
| Nullable field marker | `acontoDate DATE NULL` | `field_spec` |
| Record insert | `INSERT INTO ... VALUES theData.report` | DML |
| Wrapped source | `... wrapped` | Out of scope |

Wrapped source is already excluded from qualification. The other gaps should be
fixed locally or tracked against a newer pinned grammar commit.

## 8. Semantic Work Still Required

Phase 4 emits procedural and static-SQL sites, anchors, iterator scopes, and
member chains; the shared resolver performs overload selection, shadowing, and
package versus record versus collection binding. Phase 5 derives package
dependency sites from qualified references and reuses the structural dependency
extractor for workspace and external targets.

The remaining semantic work is:

- parser selection in the qualification command (Phase 8);
- differential dependency qualification against the structural parser;
- residual SQL and PL/SQL constructs that the pinned grammar does not parse.

Identifiers inside SQL must not automatically become symbol references.
Definition names, labels, aliases, SQL object names, named-argument labels, and
package qualifiers require explicit handling. Sites that do not bind to a known
declaration are dropped.

## 9. Integration Options

The parser sits behind the existing seam:

```ts
type OracleParserType = (input: OracleParseInputType) => OracleParseResultType;
```

Two adapters are possible:

```ts
export const structuralOracleParser: OracleParserType = ...;
export const antlrOracleParser: OracleParserType = ...;
```

Production remains bound to `structuralOracleParser` until the adoption gates
pass. Qualification may select a parser through an explicit option. Parser
selection must affect `compilerVersion` and `configHash` so a generation cannot
be reused across implementations.

For authoritative measurements, build separate binaries:

- baseline imports only the structural parser;
- candidate imports only the ANTLR parser.

A runtime switch that bundles both parsers distorts bundle size, startup, and
memory results.

## 10. Runtime Alternatives

The TypeScript runtime is not the only variable. The prototype's cost is
dominated by the full grammar, adaptive prediction, parse-tree construction, and
error recovery.

| Option | Status | Assessment |
| --- | --- | --- |
| Go target | Official ANTLR target | Cross-compiles cleanly; likely modest constant-factor gain |
| C++ target | Official ANTLR target | Fastest official option; heavy build and distribution cost |
| Rust `antlr4rust` | Community, WIP | Unofficial runtime; grammar actions and conformance need validation |
| Rust `antlr-rust-runtime` | Community | Requires a separate Rust generator; unofficial |
| tree-sitter | Different grammar model | Fast and error-tolerant; requires an Oracle grammar and new visitors |

The grammar contains embedded actions and predicates, so a port is not just a
code-generation switch. Each target needs its own base implementation.

Do not port before profiling the TypeScript parser. A Go or Rust runtime changes
a constant factor; it does not remove the 66× algorithmic gap by itself.

## 11. Adoption Gates

Adopt the full ANTLR parser only when all of the following hold:

- declarations: at least 99.5% recall and exactly 100% precision;
- references: at least 99.5% recall and exactly 100% precision;
- dependencies: at least 99.5% recall and exactly 100% precision;
- no incomplete-source recovery regression;
- no existing benchmark-gate failure for cold build, warm rebuild, or
  edit-to-fresh latency;
- peak RSS remains within the configured regression bound;
- generated and bundled artifact growth is accepted explicitly;
- `pnpm verify` passes;
- source provenance and live-qualification object matching remain unchanged.

Until then, the ANTLR adapter remains non-production. The structural parser
stays in production.

## 12. Open Questions

- Can SLL prediction with LL fallback reduce the tail without losing recovery?
- Can a PL/SQL-focused grammar subset remove unused DDL surface?
- Can per-file parsing be parallelized without exceeding memory bounds?
- Which grammar gaps are fixed upstream, and which require a local fork?
- Should conditional directives be filtered, grammar-supported, or handled by a
  preprocessing phase that reports unbalanced blocks?
- Is the full grammar fast enough for cold rebuilds, or is ANTLR only viable for
  one-file incremental reconciliation and reference repair?
