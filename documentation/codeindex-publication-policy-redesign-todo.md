# Publication Policy Redesign: Implementation Progress

This file tracks implementation progress for
[codeindex-publication-policy-redesign.md](./codeindex-publication-policy-redesign.md).
It is not normative: policy, invariants, and tool contracts live in that document.
Update this file only for checkboxes, measurements, and dated progress notes.

Date: 2026-10-20

## Current phase

Phase 6 defaults are implemented on 2026-10-20. `find_symbol` defaults to `visible`,
exact-name presence outcomes feed local analytics, CommonJS publication is deferred by
K3, and S3/O2/L1/F1 are enforced during production finalization. The real-task A/B
remains blocked on the private evaluation harness; Q2 thresholds are recorded.

Phase 5 Oracle G-B through G-F pass on the publication fixture. On the frozen production
corpus, every publication gate now passes. G-F reports zero S3/O2/L1/F1 violations, G-B
has 131,565 cross-file references all to published targets, G-C has zero CALL/ASSIGNMENT
usage mismatches, G-D reaches 99.93% reference recall at 100% precision with zero extras,
and G-E keeps 5,886 routine pairs. Q1 passes against the live database: the frozen
inventory was recompiled with `PLSCOPE_SETTINGS=IDENTIFIERS:ALL` and all 5,886 packaged
specification routines have a body definition with an identical PL/Scope signature.

Phase 4 G-A and G-A2 pass on the TypeScript compiler, VS Code, and Material UI
styled-engine corpora. The hybrid `mui-material` package remains a non-normative probe
because its hand-authored `.d.ts` files and JavaScript wrappers do not yield stable
declaration-emit truth.

## Phase 0: accept the contract

Complete on 2026-10-20 (commit `158c70d`).

- [x] Policy approved as the sole publication-policy source.
- [x] Scoped projection and three-valued exposure accepted.
- [x] Canonical binding-key encoding accepted.
- [x] Open items assigned to measurement, phase, or deferred scope.
- [x] Versioned `codeindex-publication-policy-v*.md` documents removed.
- [x] `documentation/architecture.md` points to the policy.

## Phase 1: introduce the fact seam

- [x] Define the serializable extracted fact bundle (`files`, `symbols`, `bindings`,
      `bindingContexts`, `bindingSites`, `surfaceOrigins`, `occurrences`,
      `dependencies`, `adapterStats`, `diagnostics`, `compilerMs`, `extractionMs`) at
      the `ExtractorType.build()` seam.
- [x] Add one `finalizeFacts(facts, policy)` entry point under `src/core/facts/` with
      `mode: 'enforce' | 'report'`.
- [x] Keep existing persistence, schema version 8, and tool responses unchanged.
- [x] Run classification report-only inside the build worker.
- [x] Confirm both adapters emit bounded in-memory facts without compiler or parser
      objects crossing the seam.
- [x] Add pure finalizer tests: canonical JSON, UTF-8 ID framing, deterministic
      ordering, primary/anchor selection, exposure derivation, duplicate rejection, and
      synthetic collision failure.
- [x] Confirm adapter, finalizer, and config-hash boundaries with a review pass.

Phase 1 notes:

- `src/core/facts/` now owns the serializable fact contract, canonical keys, derived
  binding/site IDs, deterministic ordering, exposure aggregation, primary/anchor
  selection, structural validation, and the report safety ceiling.
- Both adapters emit preliminary lexical bindings, one context per binding, declared
  sites, and empty surface origins. Persistence still consumes the legacy symbol and
  occurrence fields only.
- Preliminary classification is deliberately incomplete: TypeScript does not yet expand
  aliases, default roots, internal `export *`, or surface projection; Oracle does not yet
  project package member addresses beyond lexical containment. Those remain Phase 4 and
  Phase 5 work.
- Report-only finalization runs in `buildGeneration` before persistence and logs
  aggregate counts through debug output. It never persists or publishes redesigned
  facts.
- `SCHEMA_VERSION`, adapter versions, `config_hash` inputs, and tool responses are
  unchanged.

## Phase 2: dry run and prototypes

- [x] Add a report-only qualification entry point that never persists or publishes
      (`publication-report`; `test/publicationReport.test.ts`).
- [x] P-1: declaration-emission prototype on the TypeScript compiler, VS Code, and
      Material UI corpora. G-A and G-A2 pass on the three normative corpora after
      commit `01dcc36`.
- [x] P-2: compiler export-table prototype for external aliases, external stars, and
      CommonJS `export =`; public corpora and a CommonJS fixture are covered.
- [x] P-3: independent compiler-type surface-projection and reachability probe on all
      three TypeScript corpora.
- [x] Run every required measurement below. M6/M11/M12 are measured by P-3.
- [x] Classify every S3, O2, L1, and F1 violation into named classes. TypeScript corpora
      are clean; Oracle exposes `parameter_type_reference_owner`.
- [x] Record accepted per-root ceilings from observed maxima: 2,000 surface addresses and
      50,000 reachability steps, each rounded up from 2x the observed maximum.
- [x] Record P-1/P-2/P-3 outcomes in the policy document and this file.
- [x] Record M8/M9 decisions with local read-only Oracle evidence.

| ID | Measurement | Status | Result |
|---|---|---|---|
| M1 | Named nested TypeScript functions: count, total lines, p95 extent lines | Measured | Store them. TypeScript compiler 5,988 / 127,430 lines / p95 67; VS Code 1,160 / 15,701 / 43; Material UI 47 / 832 / 119. |
| M2 | JavaScript and CommonJS files in indexed roots | Measured | Material UI 530 JS (529 ESM, 1 CommonJS); TypeScript compiler and VS Code 0. No CommonJS publication enabled. |
| M4 | Definition-site count and bindings-per-symbol distribution | Measured | Definition sites 33,620 / 295,962 / 17,467. One binding per symbol; sites per binding max 13 / 8 / 3. |
| M6 | Surface addresses per root, reachability steps per root, runtime, peak memory | Measured | P-3: maximum 492/674/122 addresses and 6,815/13,286/2,147 steps per root; runtime 12.4 / 75.1 / 22.0 s; peak RSS 1.9 / 11.8 / 4.3 GB. |
| M7 | Oracle cursor pairs, spec-defined cursors, call specs, polymorphic table functions, routine pairs, ambiguity rate, overload groups, body forwards, body-less spec classification | Measured | Fixture: 6 routine pairs, 0 cursor pairs, 0 call specs, 0 PTFs, 0 ambiguity, 1 overload group, 1 body forward, 1 body-less spec. Frozen production: 5,886 routine pairs, 0 cursor pairs, 1 spec-defined cursor, 0 call specs, 0 PTFs, 0 ambiguity, 197 overload groups, 905 body forwards, 0 body-less specs. |
| M11 | Maximum reachability steps per root and accepted ceiling | Measured | Maximum 13,286 (VS Code); ceiling 50,000; headroom 3.76x. |
| M12 | Surface bindings per root/symbol, maximums, share by `anonymous`, `inherited`, `depth1` | Measured | Maximum 674 per root (VS Code), 2,202 per symbol; ceiling 2,000; headroom 2.97x. |
| M13 | Union/intersection projection cases and selected semantics | Measured | Constituent-only declarations are reachable, not projected. Cases: 7,060 / 224; 28,589 / 659; 447 / 94. |
| M14 | Merged TypeScript symbols by declaration-kind set and fixed precedence effect | Measured | No fixed precedence. 13 / 559 / 0 merged symbols; illustrative precedence would change 5 / 438 / 0 kinds. |
| R1 | Persistence × exposure × kind, occurrence role/usage/owner, source lines | Partial | Usage bits are not emitted. Source lines represented 106,173 / 816,806 / 43,408; owner and role counts recorded in reports. |
| R2 | S3, O2, L1, F1 violations grouped into named classes | Measured | TypeScript corpora and repository: 0/0/0/0. Oracle fixture: 2 `parameter_type_reference_owner` O2; all other classes 0. |

Aggregate reports and commands are committed under
[`benchmark/publication-phase2/`](../benchmark/publication-phase2/README.md). Report
artifacts contain aggregate values only. A separate local diagnostic artifact may contain
workspace-relative paths, offsets, opaque IDs, and category names; never source text,
query text, credentials, or absolute paths.

### Evidence checkpoint

- [x] Every item marked "Resolve before DDL" has a recorded measurement or decision.
      M1/M8/M9/M11/M12/M13/M14 are resolved.
- [x] Every schema-shaping case has an explicit rule in the policy.
- [x] DDL work explicitly approved. Approved on 2026-10-20.

Checkpoint complete; Phase 3 was approved and started on 2026-10-20.

## Phase 3: schema and persistence

Complete on 2026-10-20.

- [x] Bump `SCHEMA_VERSION` to 9.
- [x] Bump each adapter version whose emitted facts change. No adapter facts changed;
      both adapter versions remain `0.1.0`.
- [x] Add normalized tables, columns, foreign keys, and indexes.
- [x] Persist complete fact sets through one storage operation
      (`IndexDatabase.insertGenerationFacts`).
- [x] Validate while the generation is `building` and before publication.
- [x] Preserve atomic publication and failed-candidate isolation.
- [x] Temporary-database tests: FK integrity, deterministic IDs, collision failure,
      failed-candidate isolation, same-generation status counts.

Phase 3 notes:

- Version 9 adds `symbol` exposure and external columns, `symbol_name`,
  `symbol_name_context`, `symbol_name_site`, `surface_binding_origin`,
  `definition_site`, and `build_stats`, plus the required indexes and enforced
  occurrence metadata checks.
- `insertGenerationFacts` writes files, project contexts, symbols, bindings, sites,
  occurrences, definition sites, surface origins, dependencies, diagnostics, and build
  statistics in one transaction. Content rows remain in the immutable content store.
- Post-insert validation still runs while the candidate is `building` and checks row
  counts, foreign keys, definition-site coverage, symbol/binding context agreement, and
  surface-root exposure.
- Existing query modules still read the legacy `symbol` columns. Phase 3 therefore
  persists the adapter's current symbol display and kind, while the canonical binding
  table carries the redesigned display. Phase 4 switches every query/list mode to the
  normalized model.
- Build statistics include the core-derived `symbols_stored`, `bindings`, `sites`, and
  `occurrences_stored` metrics and adapter-emitted metrics in the closed `build_stats`
  shape.

## Phase 4: TypeScript vertical slice

Complete on 2026-10-20 except the full G-A2 corpus position association.

- [x] Bindings, aliases, external projections, default roots, surface projection,
      reachability, declaration kinds, ownership, and usage.
- [x] Every query and list mode against the new schema.
- [x] Pass G-A, G-B, G-C, G-D, and G-F.
- [x] Pass full-corpus G-A2 source association. The TypeScript compiler, VS Code, and
      Material UI styled-engine corpora pass (9,191, 99,780, and 16 declarations).
      The hybrid `mui-material` package remains a non-normative probe.
- [x] Bounded tool responses for ESM TypeScript and ESM JavaScript.

Phase 4 notes:

- Lexical addresses are the stored declaration chain. Published aliases, defaults,
  re-exports, wildcard imports, script globals, external aliases, and surface paths are
  independent bindings for the same symbol.
- TypeScript surface projection follows compiler types, emits typed segments (`member`,
  `sig`, `param`, `return`, `construct`, `awaited`, `element`), records one origin per
  published root, and marks named-type terminals reachable instead of projecting through
  them below depth zero.
- `syntheticExternalDefault` and anonymous default declarations become synthetic root
  symbols. `export default identifier` reuses the internal symbol.
- Reference usage is classified from the compiler-resolved identifier position as
  `call`, `read`, `write`, or `type_ref`.
- `find_symbol` deduplicates symbols after binding filtering, ranks exact before prefix,
  and returns binding details, definition sites, and nested truncation. `outline` returns
  path-local definitions plus a bounded re-export list. `find_references` returns flat
  occurrences with usage and owner summaries. `read_symbol` serves `text`, `sites`,
  `names`, `binding_sites`, and `binding_contexts`. `symbol_at` returns innermost
  candidates, ambiguity, and lexical ancestors.
- `finalizeFacts` runs in `enforce` mode for every normal build. Temporary-database
  validation still runs while the candidate is `building`.
- G-A and P-2 pass on the vertical-slice fixture with zero missing and extra roots.
  The reference corpus still passes precision 1 with recall 1.
- `index_status` reports persisted `build_stats` rows alongside counts and scope.
- `generated` is excluded from authored TypeScript roots as generated output. The ANTLR
  lexer and parser remain available to type resolution but are not published facts.
- The TypeScript adapter version is `0.2.0`; emitted facts and configuration hash
  changed. Oracle remains `0.1.0` until Phase 5.

## Phase 5: Oracle vertical slice

Implemented on 2026-10-20 for fixtures. Production corpus gates remain blocked on
corpus access.

- [x] Record declaration forms: specification, full definition, body forward,
      call spec, and polymorphic table function.
- [x] Heading-gated routine and cursor pairing that ignores parameter defaults,
      with heading-mismatch, ambiguous-candidate, and missing-body diagnostics.
      No signature fallback.
- [x] Private body forwards with full-definition identity, anchor, and primary
      selection.
- [x] Emit bindings, declared sites, declaration kinds, usage bits, and owners.
      Parameters and routine-local declarations are ephemeral.
- [ ] Pass G-B through G-F and the Oracle corpus gates on the frozen production
      corpus. G-B, G-C, G-D, G-E, and G-F pass on
      `test/fixtures/oracle-publication-project`. On the frozen production corpus,
      G-B and G-F pass, but G-C, G-D, and G-E fail. Evidence is in
      `benchmark/publication-phase6/oracle-gates.json`.

Phase 5 notes:

- Stored Oracle declarations are packages, specification members, standalone
  routines, body-only declarations, and nested routines. Parameters, ordinary
  locals, routine-local types/cursors/exceptions, and loop iterators are never
  persisted or searchable.
- Specification members and standalone routines are published; body-only
  declarations and nested routines are internal. Oracle does not emit
  `reachable`.
- Bindings use `owner` plus canonical `member` segments. Unquoted identifiers use
  uppercase canonical spelling; quoted identifiers preserve authored spelling.
  Tool display therefore begins with `owner["SCHEMA"]::`.
- Pairing uses the complete normalized heading apart from whitespace, parameter
  default clauses, and an explicit lone `IN`. Names, `OUT`/`IN OUT` modes,
  types, order, return types, and routine modifiers remain significant. An
  unmatched body declaration remains private instead of producing a mismatch
  diagnostic. A full cursor definition in a package spec needs no body, and
  `REF CURSOR` declarations are `ref_cursor_type`, not callable cursors.
- Usage is `call`, `read`, `write`, `read + write` for `IN OUT`, and `type_ref`.
  `%TYPE`/`%ROWTYPE` tokens are recognized as single lexer tokens. `OUT` arguments
  are refined after overload resolution.
- The structural parser revision is `structural@5`; the Oracle adapter version is
  `0.5.0` because emitted facts and the configuration hash changed.
- The vertical-slice fixture adds cursor pairing, a call spec, a polymorphic table
  function declaration, private forward pairing, cross-file usage, and OUT/IN OUT
  arguments.

## Phase 6: defaults and evaluation

Implemented on 2026-10-20, except the model-facing A/B run.

- [x] Choose default `find_symbol` exposure from measured query pollution (M5).
      Resolved to `visible`; exact-name presence evidence is in
      `benchmark/publication-phase6/`.
- [ ] Run real-task A/B and record acceptance thresholds (Q2). Thresholds are recorded;
      the A/B is blocked on the private harness and model transcripts.
- [x] Decide CommonJS support from P-2 (K3). Resolved as deferred; no CommonJS root or
      `commonjs` site is emitted.
- [x] Enable enforced measured invariants whose violation classes are resolved.
      S3, O2, L1, and F1 are measured in production finalization and fail `enforce`
      candidates. Qualification-only parser overrides stay report-only.
- [x] Record exact-name `find_symbol` presence outcomes in local analytics. The eight
      counters are aggregated by `analytics` summary output.

Phase 6 notes:

- The default exposure filter is `visible` (published or reachable). Internal-only
  names require an explicit `internal` or `any` filter.
- The corpus measurement found internal-only exact names to be 6,159 / 933 / 32,258
  across the TypeScript compiler, Material UI, and VS Code. `visible` adds only 40 / 95
  / 1,247 names over `published`, all reachable.
- Query telemetry records only presence masks and never query text, names, or paths.
- The ANTLR Oracle qualification override is not a production parser; measured
  invariants remain report-only for that override.

## Open decisions

| ID | Item | Disposition | Status |
|---|---|---|---|
| K3 | CommonJS `export =` binding name and support acceptance | Phase 6 decision | Resolved: deferred |
| M1 | Store named nested TypeScript functions | Resolve before DDL | Resolved: store |
| M5 | Default `find_symbol` exposure | Phase 6 decision | Resolved: `visible` |
| M8 | Oracle synonym/current-schema source and case folding | Resolve before DDL | Resolved: source-only names, no synonym expansion, canonical case rules |
| M9 | `find_references` grouping and pagination semantics | Resolve before DDL | Resolved: flat occurrences, keyset pagination |
| M10 | Oracle/ORDS scope and cross-language edges | Deferred scope | Deferred |
| M11/M12 | Reachability-step and surface-address ceilings | Resolve before DDL | Resolved: 50,000 steps and 2,000 addresses per root |
| M13 | Union/intersection projection semantics | Resolve before DDL | Resolved: constituent reachability |
| M14 | Merged TypeScript declaration-kind precedence | Resolve before DDL | Resolved: no fixed precedence |
| Q1 | PL/Scope signature equality for packaged spec/body routines | Oracle qualification | Passed live: 5,886/5,886 routines, 0 signature mismatches, 0 missing bodies |
| Q2 | Real-task acceptance thresholds | Phase 6 decision | Resolved: thresholds recorded; A/B blocked |

## Progress log

| Date | Phase | Note |
|---|---|---|
| 2026-10-20 | Phase 0 | Contract accepted; versioned policy documents removed; architecture references updated (`158c70d`). |
| 2026-10-20 | Phase 1 | Fact seam, report-only finalizer, TypeScript and Oracle lexical facts, and finalizer/adapter tests added. Persistence and tool contracts unchanged. |
| 2026-10-20 | Phase 2 | Added `publication-report`, P-1/P-2/P-3 prototypes, full measurement set, invariant classification, and aggregate corpus evidence. M1/M8/M9/M11/M12/M13/M14 resolved; accepted ceilings 2,000 addresses and 50,000 steps per root. Persistence unchanged. |
| 2026-10-20 | Phase 3 | Schema version 9 adds the normalized binding, site, origin, definition-site, and build-stat tables with enforced constraints and indexes. One `insertGenerationFacts` operation persists and validates complete fact sets while `building`; atomic publication and failed-candidate isolation are preserved. Adapter versions unchanged. |
| 2026-10-20 | Phase 4 | TypeScript vertical slice: aliases, default and external roots, internal stars, typed surface projection, reachability, usage bits, and symbol/fact persistence migration. Queries now read canonical bindings; `find_symbol`, `outline`, `find_references`, `read_symbol` list modes, `symbol_at`, and bounded responses are implemented. G-A/G-B/G-C/G-D/G-F pass; full G-A2 corpus association remains partial. |
| 2026-10-20 | Phase 5 | Oracle vertical slice: declaration forms, heading-gated routine/cursor pairing with parameter defaults ignored, forward identity and primary ranking, ephemeral parameters/locals, canonical owner-qualified bindings, declared sites, ownership, and usage. Fixture gates G-B/G-C/G-D/G-E/G-F pass; production corpus gates remain blocked. |
| 2026-10-20 | Phase 6 | Defaults: `find_symbol` exposure is `visible`; exact-name presence telemetry feeds local analytics; K3 defers CommonJS publication; S3/O2/L1/F1 are enforced in production finalization. Q2 thresholds recorded; real-task A/B remains blocked. |
| 2026-10-20 | Qualification | Added independent G-A2 source association. G-A/G-A2 pass on the TypeScript compiler, VS Code, and Material UI styled-engine corpora; the hybrid `mui-material` package remains a non-normative probe. Fixed merged alias/local symbols, namespace re-exports, parameter properties, computed/string object members, class expressions, private constructor parameters, conditional-alias reachability, external default aliases, and synthetic-default root sites. Oracle G-F passes on the frozen production corpus. |
| 2026-10-20 | Oracle gates | Frozen production corpus: G-B passes with 119,923 cross-file references and zero internal-only targets. G-C fails with 90 CALL and 444 ASSIGNMENT usage mismatches; 7,318 CALLs and 618 assignments remain unresolved. G-D passes precision at 100% with zero extras and fails recall at 91.20%. Nested block locals and member-chain prefixes are indexed; declaration initializers and value DEFINITION rows are normalized; pragma, SQL alias, savepoint, FOR-bound constant, type-size constant, and iterator-field contexts are suppressed. G-E passes with 5,886 routine pairs and no required body-less declarations. Q1 frozen PL/Scope signatures match for 5,654/5,654 routines; live revalidation is blocked because `USER_IDENTIFIERS` is empty. Evidence: `benchmark/publication-phase6/oracle-gates.json`. |
| 2026-10-20 | Oracle pairing | Heading equality ignores parameter default clauses and explicit lone `IN`, retaining names, `OUT`/`IN OUT` modes, types, order, return types, and routine modifiers. Unmatched body overloads remain private; a full cursor definition in a package spec needs no body; `REF CURSOR` declarations are typed as `ref_cursor_type`. This added 52 routine pairs and cleared G-E on the frozen corpus. |
| 2026-10-20 | Oracle parsers | Identical frozen qualification run with `structural@4` and `antlr@2`. Structural remains: 170,615 references matched versus 119,156 for ANTLR; ANTLR also has 67,088 missing references, 42,852 missing CALLs, and zero matched ASSIGNMENTs. No parser switch; evidence in `benchmark/publication-phase6/oracle-gates.json`. |
| 2026-10-21 | Oracle extras | Eliminated all reference extras. Truth normalization now groups spec and body rows, treats value DEFINITION rows as references when a declaration exists, converts PL/Scope byte columns to character columns, and skips declaration initializers. Resolver suppresses SQL column aliases, PRAGMA names, savepoints, FOR-bound constants, type-size constants, and iterator fields. G-D precision is 100% (171,718/171,718), recall 91.20%; G-C remains 90 CALL and 444 ASSIGNMENT mismatches. |
| 2026-10-21 | Oracle gates pass | Frozen production corpus with the live-verified export: G-B 131,445 cross-file references, 0 internal targets. G-C 0 CALL and 0 ASSIGNMENT usage mismatches. G-D 186,565/186,877 policy-visible references (99.83%), precision 100%, 0 extras. G-E 5,886 routine pairs. Q1 live: 5,886/5,886 packaged specification routines share an identical spec/body signature. Resolver now covers subtype aliases, `%TYPE`/`%ROWTYPE`, cursor rows, collection element types, chained index expressions, forward declarations, overload selection by arity/named association/defaults/direction/call position/static types, indexed assignment, cursor-for calls, and SQL constants inside cursor queries. Ambiguous overload calls remain omitted with a diagnostic, as the policy requires; the gate reports those 1,420 rows separately instead of counting them as misses. Remaining 312 policy-visible disagreements are recorded in the Phase 6 evidence. |
| 2026-10-21 | Oracle recall | Reduced the policy-visible gap from 312 to 135 references. `BULK COLLECT INTO` now assigns the element record fields by position, positioned on the receiving collection; package-body initialization blocks now index their declarations; `INSERT ... VALUES` arguments are reads and calls rather than INTO writes; a qualified parenthesis-less SQL call binds as a call while a bare SQL identifier stays a column. Remaining: 75 `FETCH ... BULK COLLECT` element writes (cursor row type outside the extent), 58 references to intentionally unstored locals, and 2 ambiguous local calls. Precision stays 100% with zero extras, and CALL/ASSIGNMENT usage mismatches stay zero. |
