# Oracle ANTLR Usage

**Status:** closed. Production uses the pinned ANTLR lexer plus a tolerant
structural scanner; the full ANTLR parser remains qualification-only. Phases 1–8
of the implementation plan are in the repository, and Phase 8 measured that the
full parser fails the precision gates and regresses dependency recall, so the
adoption decision is recorded as **retain structural**.

See the [implementation plan](./oracle-antlr-plan.md) for the completed phases and
the recorded reconsideration trigger.

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
`parseWithAntlr` / `antlrOracleParser`. Production does not import it; the
qualification command loads `antlrOracleExtractor` dynamically when `--parser
antlr` is selected.

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

Policy `v2` is the historical Phase 8 comparison policy; `--truth-policy v1`
preserves the frozen Phase 0 behavior. The authoritative production gate is
contract `oracle-o1@3` with truth policy `v5`
([Oracle O1 qualification contract](./oracle-qualification-contract.md)), which
is `v4` plus the corrected `DEFINITION` mapping. V2 applies the supported-type map to
truth references as well as actual occurrences, so columns, tables, views,
sequences, datatypes, and labels no longer inflate reference truth. Program-unit
`DEFINITION` rows are declarations, scalar `DEFINITION` rows are reference uses,
and `ITERATOR`/`RECORD ITERATOR` map to the extractor's variable kind. Package
references remain excluded because they are dependency edges.

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
`test/fixtures/oracle-qualification-golden/` validate pragma facts that PL/Scope
cannot confirm.

The frozen Phase 0 report remains a `v1` measurement. To reproduce it, pass
`--truth-policy v1`. A default run executes contract `oracle-o1@3` with `v5`.

### 6.5 Phase 7 performance

The Phase 7 harness is `scripts/benchmarkOracleAntlr.mjs`; the checked-in report
is [`benchmark/oracle-phase7/report.json`](../benchmark/oracle-phase7/report.json).
It bundles only the ANTLR adapter, parses the frozen 1,237-file corpus, and
measures sequential and 4/8-worker runs on an Apple M5 Max with 64 GB and Node
`v26.10.0`.

| Metric | Sequential | 4 workers | 8 workers |
| --- | ---: | ---: | ---: |
| Wall time | 148.0 s | 61.8 s | 46.2 s |
| Peak RSS | 4.67 GB | 8.27 GB | 11.47 GB |
| p50 file | 3.32 ms | 3.92 ms | 5.46 ms |
| p95 file | 539.7 ms | 830.4 ms | 1,192.8 ms |
| p99 file | 1,794 ms | 2,734 ms | 4,255 ms |
| Max file | 6,461 ms | 9,830 ms | 11,888 ms |

Prediction dominates. Sequential phase totals are 1.24 s tokenization, 0.71 s
lexer fill, 60.85 s SLL prediction, 81.18 s LL prediction, 2.60 s total visitor
work, and a 4.01 s recovery span that overlaps the child SLL/LL phases. Warm LL
parses with and without parse-tree construction differ by about 1%, so visitors
and tree construction are not the bottleneck; full-context prediction is.

The SLL-first strategy succeeds on 1,106 files and falls back to LL on 131. The
131 failed probes consume 28.27 s; that overhead is accepted because the 1,106
successful SLL parses avoid full LL prediction.

Warm one-file reconciliation is 0.95 ms for the median-size file and 1.89 s for
the largest 370 KB file. The sequential p95 of 540 ms fits the edit-to-fresh
warning gate, but the 6.46 s maximum exceeds the 5 s warning threshold and
remains below the 15 s failure threshold. This supports evaluating an
incremental-only rollout, not a full-build rollout.

Against the frozen Phase 0 baseline:

| Comparison | Ratio |
| --- | ---: |
| Parser-only time / structural compiler stage (2,893 ms) | 50.86× |
| Sequential wall / cold build wall (9,109 ms) | 16.25× |
| Sequential wall / warm rebuild wall (10,037 ms) | 14.75× |

The candidate bundle is 9.54 MB raw and 1.50 MB gzip. The baseline MCP bundle is
2.04 MB raw and 0.31 MB gzip; the CLI bundle is 2.21 MB raw and 0.35 MB gzip.
The candidate contains only the ANTLR adapter, so no measurement in this report
mixes both parsers.

A PL/SQL-focused grammar subset was evaluated and rejected for this phase.
Decision profiling attributes the tail to core name and expression decisions
(`general_element_part`, `routine_name`, and `general_element`), not to unused
DDL rules. Removing DDL surface would not address the measured cost.

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

- differential dependency qualification against the structural parser;
- residual SQL and PL/SQL constructs that the pinned grammar does not parse.

Parser selection is implemented in the qualification command (`--parser
structural|antlr`). It is qualification-only; production stays structural.

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

Production is bound to `structuralOracleParser` through
`createOracleExtractor(structuralOracleParserBinding)`. Qualification selects a
parser with `--parser`:

```bash
pnpm qualify:oracle --parser antlr --identifiers ... --dependencies ...
```

The ANTLR binding lives in `antlrBinding.ts` and its extractor in
`antlrExtractor.ts`. Qualification imports the extractor dynamically, so MCP and
default CLI startup do not load the generated parser. Parser selection is also
part of the configuration, and the bound extractor rejects a configuration that
selects a different parser.

Parser selection affects `compilerVersion` and `configHash` so a generation cannot
be reused across implementations. `compilerVersion` records `parser@structural`
or `parser@antlr`; `configHash` includes the parser revision. A test asserts that
the same source produces different identities and that a generation built by one
parser is not reusable by the other.

For authoritative performance measurements, build separate binaries:

- baseline imports only the structural parser;
- candidate imports only the ANTLR parser.

A runtime switch that bundles both parsers distorts bundle size, startup, and
memory results. Phase 8 quality comparison uses separate databases and the same
truth policy; it does not use bundle or startup numbers.

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

Phase 7 does not change this decision. Full-build ANTLR parsing is 50.86× the
structural compiler stage, and 8-worker parsing still takes 46.2 s with
11.47 GB peak RSS. Full-build adoption is rejected on the measured evidence.

Phase 8 measured quality under policy v2 with separate databases. ANTLR improved
declaration recall by 1.4009 pp (95.5394% → 96.9403%) and reference recall by
11.6358 pp (57.4956% → 69.1314%), but:

- declaration precision fell from 99.9711% to 99.9659%;
- dependency recall fell from 98.1734% to 97.9784%;
- neither parser reached 99.5% declaration or reference recall;
- no category reached exactly 100% precision.

The ANTLR dependency set is a strict subset of the structural set. The losses
cluster in 16 files with 298 ANTLR parse diagnostics, so the next work would be
grammar and recovery fixes, not a parser switch. Incremental-only adoption is
rejected on the same quality gates; Phase 7 edit-to-fresh evidence is not a
substitute for them.

The current production replacement evidence uses `structural@5` with contract
`oracle-o1@3` and truth policy `v5` on 1,244 live installed objects, not the
Phase 8 `structural@1`/policy `v2` population. Structural declarations
(99.9489% recall, 100% precision) and references (99.6697% / 100%) pass;
dependencies (98.1789% / 100%) still fail and are owned by #101. No ANTLR
measurement exists on that corpus and policy. The Phase 8 comparison above
remains candidate evidence for the parser quality question; it is not the
current production verdict.

The ANTLR production disposition is therefore closed: the ANTLR adapter remains
qualification-only and the structural parser stays in production. Reconsider only
when a measured structural-parser failure appears, or when an upstream grammar,
recovery, or prediction change materially alters these numbers; reopening the
investigation requires new evidence against the gates above, not a repeat of the
same comparison.

## 12. Known Limits and Reconsideration Triggers

- SLL prediction with LL fallback resolves 1,106 of 1,237 files and costs
  28.27 s in failed probes. It reduces work on the common case but does not
  remove the LL tail.
- A PL/SQL-focused grammar subset was rejected: the measured decisions are in
  core name and expression rules, not unused DDL surface.
- Per-file parsing scales to 3.2× with 8 workers, but peak RSS reaches 11.47 GB
  and wall time remains 46.2 s. More workers do not close the full-build gap.
- Full cold-rebuild adoption is not viable on this grammar. Incremental-only
  reconciliation was the remaining performance path and is now rejected on the
  unchanged quality gates.
- Grammar-fix hypotheses remain unimplemented: upstream gaps versus a local fork,
  and directive filtering versus grammar support. They reopen only together with
  new measured evidence, not on their own.
