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

## 10. Runtime Alternatives

The TypeScript runtime is not the only variable. The cost is dominated by the
full grammar, adaptive prediction, parse-tree construction, and error recovery.

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
a constant factor; it does not remove the algorithmic cost of full-context
prediction by itself.

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
- Grammar-fix hypotheses remain unimplemented: upstream gaps versus a local fork,
  and directive filtering versus grammar support. They reopen only together with
  new measured evidence, not on their own.
