# Oracle ANTLR Usage

**Status:** settled. Production uses the pinned ANTLR lexer plus a tolerant
structural scanner; the full ANTLR parser remains qualification-only. The full
parser fails the precision gates and regresses dependency recall, so the adoption
decision is **retain structural**.

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
ANTLR parser and tree objects private. It emits package and routine units,
package and routine members, parameters, variables, constants, cursors,
exceptions, subtypes, record and collection types, fields, and nested routine
scopes. It also emits reference sites, lexical scopes, nested block and loop
declarations, `%TYPE`/`%ROWTYPE` anchors, static SQL names, overload arguments,
member chains, and package dependency sites derived from qualified references.

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

## 6. Adoption decision

Production keeps the structural scanner. The full ANTLR parser remains
qualification-only: it fails the precision gates on conditional-compilation and
grammar-gap inputs, regresses dependency recall, and costs substantially more
than the structural path. Decision profiling attributes that cost to core name
and expression rules, so trimming unused DDL surface would not recover it.

Two consequences follow:

- The pinned ANTLR lexer stays in the production path because tokenization is
  the part the grammar solves well.
- Parser facts are never mixed into a published generation. `--parser antlr`
  exists for comparison runs only, and `pnpm test:oracle` covers both parsers as
  separate implementations.

## 7. Grammar-Gap Triage and Upstream Candidates

A parse diagnostic proves incompatibility with the pinned parser; it does not
by itself prove a defect in the upstream grammar. An upstream candidate must
also have authoritative Oracle syntax evidence or a successful Oracle 19c
probe. This distinction matters because accepting undocumented compatibility
syntax can increase ambiguity and prediction cost in an already ambiguous
grammar.

The upstream reproduction below was performed on 2026-10-26 against
`antlr/grammars-v4` master commit
[`8714404279b53fb9856ac6162f468667b0b853bb`](https://github.com/antlr/grammars-v4/commit/8714404279b53fb9856ac6162f468667b0b853bb).
Each case and its control were executed through `sql_script` using a parser
generated from that commit with the repository's Antlr4ng target transform.
This establishes the current-master parser behavior; it is not a full upstream
multi-target qualification run.

### 7.1 Confirmed upstream candidates

| Fixture | Layer and rule | Oracle evidence | Upstream status | Contribution action |
| --- | --- | --- | --- | --- |
| `rem-comment.sql` | Lexer, `REMARK_COMMENT` | SQL*Plus permits spaces or tabs between command words and defines `REM[ARK]` as a line comment: [SQL*Plus Basics](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqpug/SQL-Plus-basics.html), [REMARK](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqpug/REMARK.html) | Current master still requires a literal space before comment text. Tracked by [`grammars-v4#5124`](https://github.com/antlr/grammars-v4/issues/5124). | Accept horizontal whitespace without consuming the newline and add space- and tab-separated upstream examples. |
| `keyword-identifier.pks` | Parser, `regular_id` | PL/SQL permits keywords as ordinary identifiers and lists `DATE` as a keyword rather than a reserved word: [Lexical Units](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/lexical-units.html#GUID-53E09662-5AD4-4530-8C6B-FF3F7C7430D5), [PL/SQL Reserved Words and Keywords](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/plsql-reserved-words-keywords.html) | General defect tracked by [`grammars-v4#720`](https://github.com/antlr/grammars-v4/issues/720); current-master evidence is recorded in [this comment](https://github.com/antlr/grammars-v4/issues/720#issuecomment-6410839042). Current master does not admit `DATE`, `DETECTED`, or `ENCLOSED` through `regular_id`. | Split the fixture into one case per token, add the minimum safe alternatives, and measure ambiguity and prediction cost. A generic “all keywords are identifiers” change is not justified. |
| `xmltable-returning-sequence.sql` | Parser, `xmltable` | Oracle 19c documents `RETURNING SEQUENCE BY REF` after the optional passing clause and before `COLUMNS`: [XMLTABLE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/XMLTABLE.html), [`XMLTABLE_options`](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/img_text/xmltable_options.html) | Current master fails the valid reduced form `XMLTABLE('/x' RETURNING SEQUENCE BY REF)`. Tracked by [`grammars-v4#5125`](https://github.com/antlr/grammars-v4/issues/5125). | Correct the local fixture, which currently places the clause after `COLUMNS`; add the clause in its documented position and test combinations with `PASSING` and `COLUMNS`. |
| `sqlplus-exec.sql` | Parser, `sql_plus_command` | SQL*Plus 19c defines `EXEC[UTE] statement`: [SQL*Plus Quick Reference](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqpqr/index.html) | Current master fails both `EXEC` and `EXECUTE`. Tracked by [`grammars-v4#5126`](https://github.com/antlr/grammars-v4/issues/5126); broader SQL*Plus boundaries remain in [`#1635`](https://github.com/antlr/grammars-v4/issues/1635) and [`#3658`](https://github.com/antlr/grammars-v4/issues/3658). | Add a line-bounded SQL*Plus command alternative without weakening PL/SQL `EXECUTE IMMEDIATE` parsing. |

The lexer’s former alternative-quote limitation is the model for this work:
[`grammars-v4#5029`](https://github.com/antlr/grammars-v4/issues/5029) records a
minimal reproducer, Oracle documentation, expected and actual behavior, and the
affected rule. Its fix was merged as
[`grammars-v4#5030`](https://github.com/antlr/grammars-v4/pull/5030); the pinned
grammar predates that merge and still carries the local adaptation described in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

### 7.2 Observed incompatibilities that are not yet upstream candidates

| Fixture | Why it is not yet an upstream candidate | Required evidence |
| --- | --- | --- |
| `constant-size-type.pks` | Oracle 19c documents a `CHAR` or `VARCHAR2` maximum size as an integer literal, explicitly not a constant or variable: [SQL Data Types](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/sql-data-types.html). | A successful Oracle 19c compile of the reduced source, plus the applicable compatibility setting, before proposing an `expression` in `precision_part`. |
| `json-strict.pkb` | The documented form is `IS JSON STRICT`, without parentheses: [SQL/JSON Conditions](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/SQL-JSON-Conditions.html). | A successful Oracle 19c compile showing that `IS JSON(STRICT)` is accepted compatibility syntax and is not produced by preprocessing. |
| `nullable-field.pks` | Oracle documents fields as nullable by default and exposes only an explicit `NOT NULL` field constraint: [Record Variables](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/record-variables.html), [Record Variable Declaration](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/record-variable-declaration.html). | A successful Oracle 19c compile proving explicit `DATE NULL` is accepted in a record field. |
| `record-insert.sql` | Oracle’s PL/SQL extension permits a whole record variable after `VALUES`; it does not document the fixture’s unparenthesized scalar field expression: [INSERT Statement Extension](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/INSERT-statement-extension.html), [Restrictions on Record Inserts and Updates](https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/restrictions-record-inserts-and-updates.html). | Replace the fixture with the exact valid production construct or obtain a successful Oracle 19c compile of the reduced form. Then identify whether `values_clause` needs a record, member-chain, or ordinary-expression alternative. |
| `wrapped.pkb` | Wrapped source intentionally hides the source grammar and is outside static indexing scope. | None; do not submit this as a grammar defect. |

These fixtures remain useful regression evidence for the pinned parser, but
must not be presented upstream as valid Oracle syntax until the missing evidence
is recorded. They are not part of the qualification corpus.

### 7.3 Contribution procedure

For each confirmed candidate:

1. Reduce it to one documented construct and preserve the corresponding fixture
   under `test/fixtures/oracle-grammar-gaps/`. Correct a fixture before using it
   as evidence when its syntax differs from the authoritative grammar.
2. Cite Oracle 19c documentation. If the syntax is undocumented compatibility
   behavior, capture a read-only or rollback-safe Oracle 19c probe and its
   compatibility settings instead.
3. Reproduce against the pinned grammar and the current upstream master with
   the upstream test harness. Record lexer tokens, the first parser diagnostic,
   and the affected rule.
4. Search upstream issues and pull requests. Add to an existing issue when its
   scope matches; otherwise file one issue per independent rule change.
5. Include the reduced input as an upstream example and run the PL/SQL grammar
   suite. For `regular_id` or expression changes, also measure prediction time
   because those rules dominate parser cost.
6. After an upstream fix is merged, update the pinned commit and digests, remove
   any redundant local adaptation, regenerate deterministically, and change the
   local fixture from an expected diagnostic to an expected successful parse.

## 8. Semantic Work Still Required

The adapter emits procedural and static-SQL sites, anchors, iterator scopes, and
member chains; the shared resolver performs overload selection, shadowing, and
package versus record versus collection binding. Package dependency sites are
derived from qualified references and reuse the structural dependency extractor
for workspace and external targets.

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
memory results. A quality comparison uses separate databases and the same truth
policy; it does not use bundle or startup numbers.

## 10. Performance Diagnosis and Improvement Options

“Parser cost” here means executing the generated parser, not the infrequent
build-time generation of TypeScript from the `.g4` files. Generated artifacts
are pinned and checked in, so generation is not on the indexing path.

### 10.1 Measured cause

The retained runtime benchmark sampled 15 files and 835,953 bytes from the
1,237-file corpus. In one shared-DFA pass, the TypeScript parser core took
10,448.687 ms and the complete adapter took 10,707.186 ms. All non-core phases
therefore added about 258.5 ms; the parser core accounts for 97.6% of elapsed
time. Peak TypeScript RSS was 913.2 MB. See
[`benchmark/oracle-antlr-runtime/reference-results.md`](../benchmark/oracle-antlr-runtime/reference-results.md).

Separate qualification profiling attributes the large-file tail to the core
`general_element_part`, `routine_name`, and `general_element` decisions. Warm LL
runs with and without parse-tree construction differed by about 1%. Adaptive
prediction, not semantic collection or tree construction, is the demonstrated
latency bottleneck.

The relevant prediction costs are:

- adaptive prediction across a large, ambiguous SQL and PL/SQL grammar;
- broad name and expression rules, including keywords that are also legal
  identifiers;
- a failed SLL probe followed by a second full-context LL parse on difficult
  files;
- error recovery and solidus-segment reparsing when a grammar gap produces
  diagnostics.

Token streams, parse trees, parser contexts, and shared DFA state remain part of
the measured memory footprint. Disabling tree construction is therefore a
memory experiment, not a leading latency optimization. Grammar fixes can remove
recovery work for affected files, but they are not automatically performance
wins. In particular, broadening `regular_id` can increase prediction ambiguity
and must be measured.

### 10.2 Runtime alternatives

Changing the runtime affects constants, not the grammar's prediction problem.
The same retained sample produced these build-shaped one-pass results:

| Option | Status | Assessment |
| --- | --- | --- |
| Go target | Official ANTLR target | 9,003.584 ms, only 1.16× faster than TypeScript core; peak RSS 1,431.8 MB |
| C++ target | Official ANTLR target | Fastest official option; heavy build and distribution cost |
| Rust `antlr4rust` | Community, WIP | Unofficial runtime; grammar actions and conformance need validation |
| Rust `antlr-rust-runtime` | Community | LL-only benchmark took 150,591.181 ms; not prediction-equivalent and not viable |
| tree-sitter | Different grammar model | Fast and error-tolerant; requires an Oracle grammar and new visitors |

The grammar contains embedded actions and predicates, so a port is not just a
code-generation switch. Each target needs its own base implementation.

The current TypeScript profile and runtime comparison do not justify a port. A
Go, Rust, or C++ runtime changes a constant factor; it does not remove the
algorithmic cost of full-context prediction by itself.

### 10.3 Prioritized experiments

Run these as isolated experiments, in order, against the quality and performance
gates in section 11:

1. Re-run and extend decision-level prediction profiling after each grammar
   change, ranking decisions by elapsed time, ATN transitions, ambiguity, and LL
   fallback. Refactor only measured hot name and expression decisions through
   left-factoring or narrower alternatives.
2. Compare always parsing SQL*Plus solidus-delimited units with the current
   whole-file-first strategy. Smaller prediction contexts may cap the worst
   cases, but repeated parser setup can regress small files.
3. If memory is the target, prototype parse listeners with parse-tree
   construction disabled. This requires redesigning semantic extraction and the
   existing timing evidence predicts little latency improvement.
4. Retain changed-file-only reconciliation for edit latency. It does not improve
   cold builds and therefore cannot justify full-parser production adoption by
   itself.
5. Use bounded file-level parallelism only for throughput measurements. Memory
   grows with worker count, so parallelism is not a per-file latency fix.

SLL-only parsing, indiscriminate keyword acceptance, more workers, and removal
of unused DDL surface are not acceptable shortcuts: they respectively regress
valid-source coverage, can worsen ambiguity, increase memory, or leave the
measured hot rules untouched.

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

The full parser fails these gates on quality and cost. Its dependency set is a
strict subset of the structural set, its losses cluster in files with parse
diagnostics, and full-build parsing costs an order of magnitude more than the
structural compiler stage. Grammar and recovery fixes would be the prerequisite
for reconsideration, not a parser switch.

The ANTLR production disposition is therefore closed: the ANTLR adapter remains
qualification-only and the structural parser stays in production. Reconsider only
when a measured structural-parser failure appears, or when an upstream grammar,
recovery, or prediction change materially alters the cost or quality result;
reopening the investigation requires new evidence against the gates above.

## 12. Known Limits and Reconsideration Triggers

- SLL prediction with LL fallback resolves most files but does not remove the
  LL tail; failed probes remain a material share of parse time.
- A PL/SQL-focused grammar subset was rejected: the costly decisions are in core
  name and expression rules, not unused DDL surface.
- Per-file parsing parallelizes but memory grows with worker count. More workers
  do not close the full-build gap.
- Full cold-rebuild adoption is not viable on this grammar. Incremental-only
  reconciliation was the remaining performance path and is now rejected on the
  unchanged quality gates.
- Upstream grammar gaps are now tracked by `grammars-v4#5124`, `#720`, `#5125`,
  and `#5126`; fixes remain unimplemented. An upstream fix or local fork reopens
  adoption only with new quality and performance evidence, not by itself.
