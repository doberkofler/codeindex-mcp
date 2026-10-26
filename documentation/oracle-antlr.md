# Oracle ANTLR Usage

**Status:** settled for production. Production uses the pinned ANTLR lexer plus
a tolerant structural scanner; the full ANTLR parser remains
qualification-only. Current `structural@5` evidence passes `oracle-o1@4` with
truth policy `v5`. The comparative decision evidence is historical
(`structural@1` versus `antlr@1`, policy `v2`); current `antlr@2` has not been
qualified against the current contract. The adoption decision remains **retain
structural** until a new full-parser campaign passes every current quality and
performance gate.

## 1. Why ANTLR Is Used

Oracle SQL and PL/SQL cannot be indexed safely with a regular-expression or
line-based splitter alone. The adapter needs to distinguish:

- strings, comments, quoted identifiers, and alternative-quoted strings;
- package specifications, package bodies, and standalone routines;
- nested blocks, `CASE` expressions, and `END` boundaries;
- conditional-compilation directives;
- SQL and PL/SQL keywords from ordinary identifiers.

The upstream `antlr/grammars-v4` Oracle lexer provides the tokenization baseline
for those cases, with pinned local adaptations and the known `REM<TAB>` defect
in section 4. The production adapter therefore uses ANTLR for lexing and a
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

Tokenization itself does not evaluate conditional compilation. The structural
path applies literal-branch filtering in `TokenCursor`; the full-parser path
blanks the same source ranges in `prepareConditionalSource` before reparsing.
Both paths keep every branch of a non-literal condition because the adapter does
not evaluate session values or compilation parameters.

### 4.1 Known production lexer defect

The pinned `REMARK_COMMENT` rule accepts an ASCII space, but not a tab, between
`REM[ARK]` and comment text. A `REM<TAB>` line is therefore emitted as visible
tokens. This is a production defect because the structural scanner consumes the
same lexer output: declaration-shaped text on such a comment line can become a
phantom declaration without a diagnostic. The minimal fixture does not expose
that consequence because it contains only punctuation and a `SELECT`.

The upstream defect is open as
[`antlr/grammars-v4#5124`](https://github.com/antlr/grammars-v4/issues/5124).
Treat it as a production lexer issue, not only as full-parser qualification
evidence. The token contract above is not satisfied for this input until the
rule is fixed locally or upstream.

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

These artifacts are retained deliberately for reproducible qualification and
upstream grammar work. They participate in TypeScript compilation and the
deterministic regeneration test, but the generated parser is absent from the MCP
bundle and is loaded by the CLI only when `--parser antlr` is selected. The
historical isolated-bundle measurements in section 10 account for its production
cost; source size alone is not the adoption gate.

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

This logic intentionally duplicates the structural filtering in `TokenCursor`
because the full parser needs offset-preserving source, while the structural
parser needs only a visible-token view. The two implementations must remain
behaviorally aligned. Keeping both branches of a non-literal condition can emit
duplicate declarations when both branches declare the same name; this behavior
exists in both parsers and is a known production limitation, not an upstream
grammar defect. No retained evidence attributes a quantified share of the
historical ANTLR precision loss to this preprocessing.

### 5.4 Declaration facts

`antlrDeclarations.ts` converts the parse tree into the declaration portion of
`OracleParseResultType`. It emits package specifications, package bodies,
standalone routines, package and routine members, parameters, variables,
constants, cursors, exceptions, subtypes, record and collection types, and
record fields. Parent indexes, unit indexes, export flags, overload identity, and
declaration ranges follow the structural parser.

The committed fixtures compare the two implementations where their contracts
overlap. Earlier comparisons listed structural limitations that no longer apply
to `structural@5`: the structural parser now emits symbolic and
`%TYPE`/`%ROWTYPE` type references, parses nested `DECLARE` locals, recognizes
`EXTERNAL` and Java call specs, and covers complete routine ranges. ANTLR still
materializes numeric and cursor loop iterators as `variable` declarations;
structural scanning recognizes iterator-based reference chains but does not
materialize those iterator declarations.

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

`%TYPE` and `%ROWTYPE` anchors produce `type-reference` sites in both current
parsers. Qualification compares dependency targets rather than dependency-site
kinds because `USER_DEPENDENCIES` does not contain those site kinds.

Target slicing is syntactic and has one known ambiguity: a three-part call such
as `pkg.coll.exists(1)` has the same shape as `schema.package.member(1)`. Both
parsers currently derive `package-call:PKG.COLL`; the shared extractor preserves
that unresolved call as an external edge. This is a downstream dependency
classification defect, not an upstream grammar defect. Catalogue-backed synonym
and schema/package collision resolution remains outside O1 scope. Normal and
recovery parses offset dependency indexes alongside declaration and reference
indexes.

## 6. Adoption decision

Production keeps the structural scanner. That decision rests on two distinct
evidence generations which must not be presented as one current comparison.

The authoritative production result is
[`structural@5` under `oracle-o1@4` and truth policy `v5`](../benchmark/oracle-production-20261027/README.md).
Its truth comes from exported PL/Scope `USER_IDENTIFIERS` rows and
`USER_DEPENDENCIES`, normalized by the executable contract. It does not use
`ALL_IDENTIFIERS` or `ALL_DEPENDENCIES`.

The full-parser comparison was committed in
[`76961feb140504e9f5d79143d0aa4b090954c8e8`](https://github.com/doberkofler/codeindex-mcp/tree/76961feb140504e9f5d79143d0aa4b090954c8e8/benchmark/oracle-phase8).
It compared `structural@1` with `antlr@1` on 1,237 files under superseded truth
policy `v2`:

| Evidence | Declarations recall / precision | References recall / precision | Dependencies recall / precision |
| --- | ---: | ---: | ---: |
| Current `structural@5`, contract `@4` / policy `v5` | 99.9489% / 100% | 99.6697% / 100% | 100% / 100% |
| Historical `structural@1`, policy `v2` | 95.5394% / 99.9711% | 57.4956% / 99.3464% | 98.1734% / 100% |
| Historical `antlr@1`, policy `v2` | 96.9403% / 99.9659% | 69.1314% / 99.3900% | 97.9784% / 100% |

The historical ANTLR parser improved declaration and reference recall but missed
every recall gate, missed exact declaration and reference precision, and
regressed dependency recall by 0.1951 percentage points. Its losses clustered in
16 files with 298 parse diagnostics. The retained report does not attribute a
quantified share of those losses or the precision extras to conditional
compilation or to the nine reduced grammar-gap fixtures.

Current code identifies the full parser as `antlr@2`. There is no committed
`antlr@2` qualification report under contract `oracle-o1@4` and policy `v5`, so
the historical failures are decision provenance, not present-tense current-gate
results. Reconsideration requires a new comparable report. Historical
full-corpus performance evidence independently supported the retained decision
and is recorded in section 10.

Two consequences follow:

- The pinned ANTLR lexer stays in the production path because tokenization is
  the part the grammar solves well.
- Parser facts are never mixed into a published generation. `--parser antlr`
  exists for comparison runs only, and `pnpm test:oracle` covers both parsers as
  separate implementations.

## 7. Known Grammar Gaps

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

### 7.1 Fixture provenance

The reduced fixtures were committed without source-path provenance. The retained
SVN r78950 production-source snapshot contains the corresponding constructs
below. Source presence establishes origin, not successful deployment or Oracle
compilation: scripts can be inactive, compatibility-dependent, or transformed,
and reduction can change validity.

| Fixture | Retained source origin | Reduction caveat |
| --- | --- | --- |
| `rem-comment.sql` | `OTHER/c_views.sql` and other scripts contain `REM<TAB>` lines. | The fixture keeps the tab but replaces the comment text. |
| `keyword-identifier.pks` | `PACKAGES/las_rep_sijournal.pkb` uses `detected`; `UnitTest/unittests/ods_uti_parsecsv_ut.pkb` uses `enclosed`. | The fixture combines independent names; `DATE` is supported by Oracle documentation rather than traced to the same source. |
| `constant-size-type.pks` | `PACKAGES/las_mod_storedreport_run.pkb` uses `VARCHAR2(kMaxLen CHAR)`. | Source presence does not establish the compatibility setting under which it compiles. |
| `xmltable-returning-sequence.sql` | `PACKAGES/las_mod_importeinvoice_xml.pkb` places `RETURNING SEQUENCE BY REF` before `COLUMNS`. | The local fixture moved the clause after `COLUMNS` and is invalid; the upstream issue uses the documented order. |
| `json-strict.pkb` | `PACKAGES/las_sql_aiassistant.pkb` uses `IS JSON(STRICT)`. | Oracle documents the unparenthesized form, so a compile probe remains required for the reduced form. |
| `sqlplus-exec.sql` | `FILL/f_reportsettings.sql` and other scripts use SQL*Plus `EXEC`. | This is a SQL*Plus command, not stored PL/SQL source. |
| `nullable-field.pks` | `PACKAGES/las_sub_reportform.pks` contains a `DATE NULL` field. | Oracle documentation exposes only explicit `NOT NULL`; a compile probe remains required. |
| `record-insert.sql` | `PACKAGES/las_mod_storedreport_data.pkb` contains `INSERT ... VALUES theData.report`. | The fixture changes the surrounding declaration and target table. |
| `wrapped.pkb` | `PACKAGES/ods_sys_encryption.pkb` is wrapped. | Wrapped source is intentionally outside static indexing scope. |

The fixtures are not part of the qualification corpus. Their tests prove only
that the pinned parser reports a diagnostic. No retained report maps them to a
share of historical recall loss, so fixing all nine cannot be claimed to close a
known percentage of the gate gap.

### 7.2 Confirmed upstream candidates

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

The open service requests remain valid. Issue #5124 also has downstream
production impact through the shared lexer. Issue #5125 already uses a valid
reproducer in the documented clause order; only the local fixture needs
correction. Issue #5126 remains qualification-only for this adapter. The comment
on #720 is supported by Oracle documentation; a successful Oracle 19c compile
would strengthen, but is not required to retract, the report. The use of the
independent Antlr4ng target does not invalidate these target-neutral grammar
omissions, although reproduction with an official ANTLR target would strengthen
the submissions.

### 7.3 Observed incompatibilities that are not yet upstream candidates

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

### 7.4 Contribution procedure

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

- qualify current `antlr@2` and `structural@5` outputs under the same
  `oracle-o1@4` / `v5` contract before making a new comparative claim;
- resolve package/member versus schema/package slicing for three-part dependency
  chains such as `pkg.coll.exists`;
- define one behavior contract for non-literal conditional compilation and
  prevent duplicate facts when both retained branches declare the same name;
- measure which production losses, if any, each reduced grammar-gap class
  explains;
- address residual SQL and PL/SQL constructs that the pinned grammar does not
  parse.

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
1,237-file corpus by size quantile. It ran three isolated cold processes per
file, one warmup plus five warm samples per file, and one shared-DFA corpus pass.
That corpus pass has no repetition or variance estimate. In the shared pass, the
TypeScript parser core took 10,448.687 ms and the complete adapter took
10,707.186 ms. All non-core phases therefore added about 258.5 ms; the parser
core accounts for 97.6% of elapsed time. Peak TypeScript RSS was 913.2 MB. See
[`benchmark/oracle-antlr-runtime/reference-results.md`](../benchmark/oracle-antlr-runtime/reference-results.md).

The 15-file pass is useful for phase attribution and runtime comparison. It has
no structural-parser timing and is not the source of the full-build
order-of-magnitude claim.

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

### 10.2 Historical full-corpus decision evidence

Phase 7 parsed all 1,237 files and 20,817,931 bytes with an isolated ANTLR
candidate bundle. The immutable report is committed at
[`7573a8bb5e69eceb14f9eed0912185cbd5b77505`](https://github.com/doberkofler/codeindex-mcp/blob/7573a8bb5e69eceb14f9eed0912185cbd5b77505/benchmark/oracle-phase7/report.json):

| Metric | Structural baseline | ANTLR candidate | Ratio |
| --- | ---: | ---: | ---: |
| Cold-build wall time | 9,109 ms | 148,041.474 ms | 16.25× |
| Structural compiler / ANTLR parser time | 2,893 ms | 147,133.566 ms | 50.86× |
| Single-worker ANTLR peak RSS | — | 5,018,288,128 bytes | — |

This is the source of the claim that full parsing cost an order of magnitude
more than the structural path. It is historical decision evidence, not a current
`antlr@2` benchmark. The current `structural@5` production baseline is retained
separately in
[`benchmark/oracle-performance`](../benchmark/oracle-performance/README.md).

### 10.3 Runtime alternatives

Changing the runtime affects constants, not the grammar's prediction problem.
The same retained sample produced these build-shaped one-pass results:

| Option | Ownership | Evidence here | Assessment |
| --- | --- | --- | --- |
| Go target | Official ANTLR target | Measured | 9,003.584 ms, only 1.16× faster than TypeScript core; peak RSS 1,431.8 MB |
| C++ target | Official ANTLR target | Unmeasured | Requires a new base implementation plus build and distribution support |
| Rust `antlr4rust` | Community, WIP | Unmeasured | Grammar actions and conformance need validation |
| Rust `antlr-rust-runtime` | Community | Measured, LL-only | 150,591.181 ms; not prediction-equivalent and not viable |
| tree-sitter | Different grammar model | Unmeasured | Requires an Oracle grammar and new visitors |

The TypeScript baseline uses `antlr4ng`, which belongs to the independent ANTLR
Next Generation project; it is not the official `antlr/antlr4` TypeScript
runtime. Go and C++ are official ANTLR targets. Runtime ownership does not alter
the measured result, but it is part of the portability and maintenance decision.

The grammar contains embedded actions and predicates, so a port is not just a
code-generation switch. Each target needs its own base implementation.

The current TypeScript profile and runtime comparison do not justify a port. A
Go, Rust, or C++ runtime changes a constant factor; it does not remove the
algorithmic cost of full-context prediction by itself.

### 10.4 Prioritized experiments

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

The semantic thresholds come from the authoritative
[`oracle-o1@4` qualification contract](./oracle-qualification-contract.md), not
from this parser decision document. Exact precision is deliberately
non-compensable: an incorrect symbol or package edge can misdirect navigation and
impact analysis, while a bounded miss remains unresolved rather than asserting a
false fact. The precision gate is directly falsifiable by one scored extra;
current `structural@5` meets it.

Adopt the full ANTLR parser only when one current, comparable campaign shows all
of the following:

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

Current `structural@5` passes the semantic gates. Current `antlr@2` has no report
under the current contract. Historically, `antlr@1` failed the quality gates,
its dependency set was a strict subset of the `structural@1` set, and its losses
clustered in files with parse diagnostics. Historical full-build parsing also
cost 16.25× the structural cold build and 50.86× the structural compiler stage.
Grammar and recovery fixes are necessary for another campaign, but cannot by
themselves satisfy the performance gates.

The ANTLR production disposition is therefore closed: the ANTLR adapter remains
qualification-only and the structural parser stays in production. Known
structural and lexer defects require direct fixes; their existence does not make
the full parser viable. Reconsider a parser switch only when the candidate
materially improves a measured production failure and a new campaign passes
every gate above.

## 12. Known Limits and Reconsideration Triggers

- The shared production lexer does not hide `REM<TAB>` comments. This is tracked
  by `grammars-v4#5124` and requires a production fix independently of parser
  adoption.
- Both parsers retain all branches of non-literal conditional compilation and
  can emit duplicate declarations for equivalent branch APIs.
- Both parsers can misclassify `pkg.coll.exists` as an unresolved call to package
  `PKG.COLL` because dependency target slicing is syntactic.
- Structural scanning does not materialize numeric and cursor loop iterators as
  declarations, although it recognizes iterator-based reference chains.
- SLL prediction with LL fallback resolves most files but does not remove the
  LL tail; failed probes remain a material share of parse time.
- A PL/SQL-focused grammar subset was rejected: the costly decisions are in core
  name and expression rules, not unused DDL surface.
- Per-file parsing parallelizes but memory grows with worker count. More workers
  do not close the full-build gap.
- Full cold-rebuild adoption was not viable in the retained campaign.
  Changed-file-only reconciliation remains the production edit-latency strategy,
  but incremental-only operation cannot justify adopting a parser that misses
  the unchanged quality gates.
- Upstream grammar gaps are now tracked by `grammars-v4#5124`, `#720`, `#5125`,
  and `#5126`; fixes remain unimplemented. Apply each fix according to its
  production or qualification impact. No individual fix reopens full-parser
  adoption without current quality and performance evidence.
