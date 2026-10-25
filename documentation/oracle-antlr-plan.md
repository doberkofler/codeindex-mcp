# Oracle ANTLR Implementation Plan

**Status:** closed. Phase 0 is frozen, Phases 1–8 are implemented behind a
qualification-only adapter seam, and the disposition is decided: no production
switch. The structural parser remains authoritative, and reconsideration requires
a new measured trigger rather than a repeat comparison.

## Progress

| Phase | Status |
| --- | --- |
| 0 — Baseline | Executed; frozen in `benchmark/oracle-phase0` |
| 1 — Grammar toolchain | Implemented; generated artifacts are deterministic |
| 2 — Parser and recovery | Implemented; segment recovery and bounded diagnostics |
| 3 — Declarations | Implemented; members, parameters, types, fields, and nested routines |
| 4 — References and scope | Implemented; procedural and SQL sites, lexical scopes, anchors, member chains |
| 5 — Dependencies | Implemented; package calls, package references, type references, external targets |
| 6 — Qualification v2 | Implemented; versioned truth policy, extra classes, strata, golden facts |
| 7 — Performance | Implemented; evidence in `benchmark/oracle-phase7`; full-build parity not met |
| 8 — Integration and rollout | Integration implemented; quality evidence in `benchmark/oracle-phase8`; production stays structural |

## 1. Goal

Replace the tolerant structural declaration/reference/dependency scanner with a
full ANTLR parse plus project-specific semantic visitors, without changing the
public extractor contract or weakening qualification gates.

Success means:

- the same `OracleParseResultType` seam and extractor interface;
- equal or better declaration and dependency precision;
- materially better reference recall, especially for static SQL and member
  chains;
- no source-provenance regression;
- acceptable cold-build, edit-to-fresh, and memory performance.

## 2. Non-Goals

- Indexing triggers, object types, views, tables, or live catalogue metadata.
- Cross-language edges or ORDS lineage.
- Runtime fallback from ANTLR to the structural parser.
- Merging facts from both parsers into one generation.
- A Go, Rust, or C++ port before the TypeScript implementation is profiled.
- Raising qualification thresholds or deleting legitimate facts to pass.

## 3. Workstreams

### Phase 0 — Freeze the baseline

**Status:** executed. The frozen evidence is in
[`benchmark/oracle-phase0`](../benchmark/oracle-phase0/README.md); grammar-gap
fixtures are in [`test/fixtures/oracle-grammar-gaps`](../test/fixtures/oracle-grammar-gaps/README.md).

**Deliverables**

- Committed baseline SHA and clean worktree.
- Frozen corpus manifest, source hashes, and exclusion list.
- Frozen PL/Scope exports (`USER_IDENTIFIERS`, `USER_DEPENDENCIES`).
- Structural-parser qualification report and benchmark report.
- A checked-in grammar-gap fixture set for the known failing constructs.

**Exit criteria**

- The same corpus can be rebuilt from the recorded SHA and manifest.
- Baseline qualification and benchmark commands are documented and repeatable.

**Approvals**

- Adding `grammar/oracle/PlSqlParser.g4`, generated parser files, and a parser
  base class.
- Any `package.json`, build, lint, or formatting configuration change.

### Phase 1 — Pin and generate the parser

**Tasks**

1. Extend `scripts/downloadOracleGrammar.ts` to fetch:
   - `PlSqlParser.g4` from the same pinned `antlr/grammars-v4` commit;
   - the upstream `Antlr4ng` parser base.
2. Verify the parser and base SHA-256 values before writing.
3. Apply only deterministic local adaptations:
   - parser `@header` importing `PlSqlParserBase`;
   - strict TypeScript post-processing already used by the lexer;
   - no behavioral edits without a fixture and rationale.
4. Extend `scripts/generateOracleGrammar.mjs` to generate:
   - `PlSqlParser.ts`;
   - `PlSqlParserVisitor.ts`;
   - listener only if required by the parser.
5. Add `src/adapters/oracle/plSqlParserBase.ts`.
6. Record parser provenance and adaptations in `THIRD_PARTY_NOTICES.md`.
7. Exclude generated output from authored formatting and linting, while keeping
   it in TypeScript compilation.

**Tests**

- Generation is deterministic: regenerate and assert an empty diff.
- Lexer token behavior is unchanged.
- Parser and visitor compile under the repository's strict TypeScript settings.
- Generated files contain no absolute paths, timestamps, or machine-specific
  data.

**Exit criteria**

- `pnpm grammar:oracle:generate` reproduces the checked-in artifacts byte for
  byte.
- `pnpm typecheck` passes.

### Phase 2 — Parser adapter and recovery

**Tasks**

1. Add an internal parser module, for example
   `src/adapters/oracle/antlrParser.ts`.
2. Implement:

   ```ts
   parseWithAntlr(input: {
       source: string;
       path: string;
       defaultSchema: string;
   }): OracleParseResultType
   ```

3. Convert ANTLR token positions into the existing one-based line/column and
   UTF-16 half-open offsets.
4. Add bounded lexer and parser error listeners.
5. Implement conditional-compilation handling:
   - evaluate literal `$IF TRUE` and `$IF FALSE`;
   - keep both branches for non-literal conditions;
   - detect unmatched `$IF`, `$ELSIF`, `$ELSE`, and `$END`;
   - emit a bounded diagnostic instead of silently truncating the file.
6. Add a recovery strategy that preserves later units after malformed input.
7. Release lexer, parser, token stream, and parse tree after each file.
8. Do not add automatic structural-parser fallback.

**Recovery fixtures**

- missing semicolon;
- missing `END`;
- malformed parameter list;
- unterminated string or comment;
- malformed first unit followed by a valid unit;
- truncated package body;
- disabled malformed `$IF` branch;
- nested `CASE` and `END` boundaries.

**Exit criteria**

- All selected LJS files parse without crashes or incomplete EOF handling.
- Every surviving unit after a malformed prefix is recovered.
- Every diagnostic is bounded and contains a workspace-relative path.

### Phase 3 — Declaration visitor

**Tasks**

1. Emit package specifications, package bodies, procedures, and functions.
2. Emit parameters, variables, constants, cursors, exceptions, subtypes,
   record/collection types, and fields.
3. Preserve lexical parent/child relationships and nested routine scopes.
4. Preserve package specification/body linkage rules.
5. Preserve overload identity.
6. Keep declaration names out of reference sites.

**Tests**

- The existing Oracle fixture suite passes unchanged.
- Declaration names, kinds, parents, and ranges match the structural parser on
  the LJS corpus, or differences are classified and justified.
- No declaration precision regression on the frozen truth set.

**Exit criteria**

- Declaration recall and precision are at least equal to the structural parser.
- Declaration precision is exactly 100% under the approved truth policy.

### Phase 4 — Reference visitor and scope resolution

**Status:** implemented behind the unwired adapter. Procedural and static-SQL
sites, lexical scopes, nested blocks, loop iterators, `%TYPE`/`%ROWTYPE`
anchors, overload selection, and record/collection member chains are covered.
Dependencies are implemented in Phase 5. Qualification thresholds remain
unverified because the ANTLR parser is not selectable in the qualification
command.

This is the largest and highest-risk phase.

**Tasks**

1. Visit procedural references:
   - calls and named arguments;
   - local and nested declarations;
   - parameters, variables, constants, and exceptions;
   - `%TYPE` and `%ROWTYPE` anchors;
   - record and object-type member chains.
2. Visit static SQL:
   - `SELECT`, `INSERT`, `UPDATE`, `DELETE`, and `MERGE`;
   - cursor queries and `FOR ... IN` queries;
   - subqueries, joins, aliases, and correlation names;
   - `XMLTABLE`, `JSON_TABLE`, and table-function expressions where supported.
3. Build lexical scopes:
   - package members;
   - routine locals;
   - nested blocks;
   - loop and cursor iterators;
   - shadowing rules.
4. Resolve overloads by callable kind, canonical name, argument count, named
   arguments, and defaults.
5. Resolve package versus record versus SQL alias chains.
6. Leave unresolved SQL names unresolved; do not guess.
7. Classify unresolved sites for diagnostics and later grammar/scope work.

**Tests**

- Declaration names, labels, aliases, SQL object names, named-argument labels,
  and package qualifiers never become symbol references.
- A reference is emitted only when static resolution proves a target.
- Static SQL fixtures cover aliases, joins, subqueries, and correlated names.
- Record and cursor-field chains resolve only through known types.
- Overload ambiguity produces one bounded diagnostic and no occurrence.

**Exit criteria**

- Reference recall reaches the approved threshold on a stratified truth set.
- Reference precision is exactly 100% under the approved truth policy.
- Remaining misses are classified by category, not left as unexplained noise.

### Phase 5 — Dependency visitor

**Status:** implemented behind the unwired adapter. Qualified package calls,
package references, and type references are emitted; local record, collection,
cursor, and SQL chains are excluded; the existing extractor resolves workspace
targets and preserves unresolved external package calls. Differential
qualification remains unverified because the ANTLR parser is not selectable in
the qualification command.

**Tasks**

1. Emit package calls, package references, and indexed type anchors.
2. Keep table, view, and column chains out of package dependencies.
3. Resolve workspace package targets to specification or body paths.
4. Preserve unresolved external package targets using the manifest schema.

**Exit criteria**

- Dependency recall and precision are at least equal to the structural parser.
- Dependency precision is exactly 100%.

### Phase 6 — Qualification policy v2

**Status:** implemented and superseded by contract `oracle-o1@2` (truth policy
`v3`). `v1` and `v2` remain selectable for historical comparison only.
Unsupported PL/Scope reference types are filtered from truth and actual facts,
supported `DEFINITION` rows are declarations, iterators map to variables,
extras are classified into four reason classes, and declaration/reference
metrics are stratified. Golden facts cover constructs PL/Scope does not record.

**Tasks**

1. Version the truth policy; keep v1 for historical comparison.
2. Classify every declaration and reference extra:
   - omitted by the current truth policy;
   - location-normalization mismatch;
   - legitimate fact outside PL/Scope coverage;
   - actual false positive.
3. Add supported PL/Scope types only when they map cleanly to the extractor
   interface.
4. Apply fact-class filtering symmetrically to truth and actual sets.
5. Keep package qualifiers excluded because they are dependency edges.
6. Stratify metrics by:
   - procedural references;
   - static SQL;
   - member chains;
   - iterators;
   - pragmas;
   - type anchors;
   - dependencies.
7. Use checked-in golden fixtures for facts PL/Scope cannot validate.
8. Do not raise recall by deleting legitimate facts.

**Exit criteria**

- The gates are reachable by construction and documented.
- The structural parser and ANTLR parser are compared under the same policy.
- Every excluded fact class has an explicit reason and test.

### Phase 7 — Performance

**Tasks**

1. Profile the TypeScript parser:
   - lexing;
   - adaptive prediction;
   - recovery;
   - parse-tree construction;
   - visitors.
2. Try two-stage prediction: SLL first, LL fallback on error.
3. Evaluate a PL/SQL-focused grammar subset that excludes unused DDL surface.
4. Parallelize per-file parsing within the existing worker boundary.
5. Measure one-file reconciliation separately from cold build.
6. Compare against `benchmark/baseline-external.json`.
7. Measure standalone CLI/MCP bundles, not Vitest.

**Initial measurements to beat**

| Metric | Structural | ANTLR prototype |
| --- | ---: | ---: |
| 1,632 files / 24.5 MB | 3.8 s | 252.3 s |
| p50 | ~2.3 ms average | 16 ms |
| p95 | — | 697 ms |
| p99 | — | 1,707 ms |
| Max | — | 5.0 s |
| Peak RSS (Vitest) | — | 4.1 GB |

**Status:** implemented. Evidence is recorded in
[`benchmark/oracle-phase7`](../benchmark/oracle-phase7/README.md).

- The adapter parses with SLL prediction and retries in LL only when SLL reports
  a syntax error. A bailed SLL attempt never contributes facts or diagnostics.
- `parseWithAntlrProfiled` exposes per-file lexing, prediction, visitor, and
  recovery timings without adding timers to the normal path.
- The standalone benchmark measures sequential and 4/8-worker parsing, warm
  one-file reconciliation, RSS, and a candidate-only bundle.
- A PL/SQL-focused grammar subset is rejected for this phase: decision profiling
  attributes the tail to core `general_element`, `routine_name`, and expression
  decisions, not to unused DDL rules.
- Production remains structural. The measured full-build cost still misses the
  cold-build regression gate, and parallel wiring would require an asynchronous
  extractor seam that Phase 8 has not approved.

**Exit criteria**

- Cold build, warm rebuild, and edit-to-fresh pass the existing regression
  gates, or the adoption decision is explicitly changed with evidence.
- Peak RSS and bundle-size growth are recorded and accepted.
- No performance claim is based on a bundle containing both parsers.

The first exit criterion is **not met** for a full build. The evidence supports a
later incremental-only decision, not production adoption.

### Phase 8 — Integration and rollout

**Status:** integration implemented. The parser seam accepts an injected
`OracleParserType`; production is statically bound to the structural parser; the
qualification command accepts `--parser structural|antlr`; parser identity is
persisted in `compilerVersion` and folded into `configHash`; a mismatched binding
is rejected before scanning or extraction. The ANTLR extractor is loaded through
a dynamic import so MCP and default CLI startup do not load it. Quality evidence
is recorded in
[`benchmark/oracle-phase8`](../benchmark/oracle-phase8/README.md): ANTLR improves
declaration and reference recall but fails the precision gates and regresses
dependency recall, so production was not switched and the structural parser was
not removed.

**Tasks**

1. Introduce parser injection at the adapter seam:

   ```ts
   type OracleParserType = (input: OracleParseInputType) => OracleParseResultType;
   ```

2. Keep production bound to the structural parser.
3. Add a qualification-only parser selector.
4. Include parser identity in `compilerVersion` and `configHash`.
5. Build separate baseline and candidate bundles for authoritative measurements.
6. Flip production only after all gates pass.
7. Remove the structural parser only after a stabilization period and passing
   regression evidence.

**Exit criteria**

- Switching parsers cannot reuse a generation built by the other parser.
- Production behavior is unchanged until the explicit adoption commit.
- The old parser can be restored by reverting one binding.

The first three tasks, parser identity, and the qualification selector are done.
The structural binding is the production binding. Tasks 6 and 7 are declined: the
quality gates were not met, so the switch and the removal never start.

## 4. Test Matrix

| Layer | Coverage |
| --- | --- |
| Lexer | strings, comments, quoted identifiers, alternative quotes, conditional directives |
| Grammar | pinned parser generation, deterministic diff, strict TypeScript |
| Recovery | malformed units, missing terminators, truncated bodies, unbalanced directives |
| Declarations | packages, routines, parameters, types, fields, nesting, overloads |
| References | procedural scope, static SQL, aliases, member chains, `%TYPE`/`%ROWTYPE` |
| Dependencies | package calls, package references, type anchors, external targets |
| Differential | structural vs ANTLR facts on the same frozen corpus |
| Qualification | PL/Scope truth v2, stratified recall and precision |
| Performance | cold, warm, rebuild, edit-to-fresh, RSS, bundle size |
| Provenance | frozen source mapping, object matching, stale-file rejection |

MCP protocol tests remain unchanged. Parser tests use fixtures and temporary
workspaces; no test connects to Oracle or points at a real checkout.

## 5. Sequencing

Recommended order:

```text
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
                                              │
                                              ├──► Phase 6 (parallel after Phase 2)
                                              └──► Phase 7 (parallel after Phase 4)
                                                              │
                                                              ▼
                                                          Phase 8
```

Phase 6 can start once the parser produces stable facts. Phase 7 can start once
the declaration and reference visitors exist. Do not wait for all semantic work
before measuring the parser tail.

## 6. Rough Effort

Order-of-magnitude, one engineer:

| Phase | Effort |
| --- | ---: |
| 0 — Baseline | 0.5–1 day |
| 1 — Grammar toolchain | 1–2 days |
| 2 — Parser and recovery | 2–4 days |
| 3 — Declarations | 3–5 days |
| 4 — References and scope | 8–15 days |
| 5 — Dependencies | 1–2 days |
| 6 — Qualification v2 | 2–4 days |
| 7 — Performance | 2–4 days |
| 8 — Integration | 1–2 days |
| **Total** | **~4–7 weeks** |

The reference/scope phase is the schedule risk. Grammar gaps and performance
tail work are the technical risks.

## 7. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Upstream grammar misses Oracle 19c constructs | Pinned fixtures, local adaptations, track upstream fixes |
| Conditional compilation is context-sensitive | Directive-aware parsing or filtering with explicit imbalance diagnostics |
| Static SQL scope cannot be resolved without catalogue metadata | Emit no reference when identity is unproven; use live metadata only where approved |
| ANTLR remains 50–100× slower | SLL, grammar subset, parallelism, per-file cache, or hybrid scope |
| Generated parser bloats bundles | Separate bundles, gzip measurement, subset grammar, code-generation review |
| Unofficial Rust runtime is immature | Prefer Go/C++ if a port is justified; require conformance tests |
| Truth policy omits legitimate facts | V2 applies one supported-type map to truth and actual facts and classifies extras |
| Parser facts disagree with structural facts | Differential tests; no silent union or fallback |
| Provenance breaks | Keep source mapping, hashes, and object matching outside the parser |

## 8. Decision Points

1. Approve grammar and generated-parser files.
2. Approve any package/build configuration changes.
3. Approve truth policy v2 and its exclusions.
4. Decide whether static SQL references may be emitted without catalogue
   metadata, or only when identity is proven from source.
5. ~~Decide whether the performance target is cold-build parity, bounded
   regression, or incremental-only adoption.~~ Decided: no ANTLR adoption,
   including incremental-only.
6. ~~Decide whether a Go/Rust/C++ port is justified after Phase 7 profiling.~~
   Decided: not justified. The measured gap is algorithmic, and a port changes
   only a constant factor.

## 9. Definition of Done

- Parser and visitors are behind the existing `OracleParseResultType` seam.
- All repository checks pass.
- Qualification v2 gates pass with unrounded values.
- Performance and memory are measured on standalone builds.
- The production binding stays on the structural parser; the single-commit switch
  is explicitly declined with the Phase 7 and Phase 8 evidence recorded above.
- Documentation records the retained architecture, limitations, and evidence.
