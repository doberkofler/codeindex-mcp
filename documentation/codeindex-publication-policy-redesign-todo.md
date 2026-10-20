# Publication Policy Redesign: Implementation Progress

This file tracks implementation progress for
[codeindex-publication-policy-redesign.md](./codeindex-publication-policy-redesign.md).
It is not normative: policy, invariants, and tool contracts live in that document.
Update this file only for checkboxes, measurements, and dated progress notes.

Date: 2026-10-20

## Current phase

Phase 3 schema and persistence is complete. `SCHEMA_VERSION` is 9, a complete finalized
fact set is persisted through one storage operation, and candidate facts are validated
while the generation remains `building`. Current query modules still read the symbol
table, so Phase 3 retains legacy symbol display and kind until the Phase 4 query
migration. Adapter versions are unchanged because no adapter-emitted fact changed.

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
      Material UI corpora. Root-export comparison is partial; G-A/G-A2 remain blocked.
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
| M7 | Oracle cursor pairs, call specs, polymorphic table functions, routine pairs, ambiguity rate, overload groups, body forwards, body-less spec classification | Partial | Fixture only: 6 routine pairs, 0 cursor pairs, 0 call specs, 0 PTFs, 0 ambiguity, 1 overload group, 1 body forward, 1 body-less spec (unclassified). Production Oracle corpus not run. |
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

- [ ] Bindings, aliases, external projections, default roots, surface projection,
      reachability, declaration kinds, ownership, and usage.
- [ ] Every query and list mode against the new schema.
- [ ] Pass G-A, G-A2, G-B, G-C, G-D, and G-F.
- [ ] Bounded tool responses for ESM TypeScript and ESM JavaScript.

## Phase 5: Oracle vertical slice

- [ ] Record declaration forms.
- [ ] Exact heading-gated routine and cursor pairing.
- [ ] Private body forwards with full-definition identity and primary selection.
- [ ] Emit bindings, sites, kinds, usage, and owners.
- [ ] Pass G-B through G-F and the Oracle corpus gates.

## Phase 6: defaults and evaluation

- [ ] Choose default `find_symbol` exposure from measured query pollution (M5).
- [ ] Run real-task A/B and record acceptance thresholds (Q2).
- [ ] Decide CommonJS support from P-2 (K3).
- [ ] Enable enforced measured invariants whose violation classes are resolved.

## Open decisions

| ID | Item | Disposition | Status |
|---|---|---|---|
| K3 | CommonJS `export =` binding name and support acceptance | Phase 6 decision | Open |
| M1 | Store named nested TypeScript functions | Resolve before DDL | Resolved: store |
| M5 | Default `find_symbol` exposure | Phase 6 decision | Open |
| M8 | Oracle synonym/current-schema source and case folding | Resolve before DDL | Resolved: source-only names, no synonym expansion, canonical case rules |
| M9 | `find_references` grouping and pagination semantics | Resolve before DDL | Resolved: flat occurrences, keyset pagination |
| M10 | Oracle/ORDS scope and cross-language edges | Deferred scope | Deferred |
| M11/M12 | Reachability-step and surface-address ceilings | Resolve before DDL | Resolved: 50,000 steps and 2,000 addresses per root |
| M13 | Union/intersection projection semantics | Resolve before DDL | Resolved: constituent reachability |
| M14 | Merged TypeScript declaration-kind precedence | Resolve before DDL | Resolved: no fixed precedence |
| Q1 | PL/Scope signature equality for packaged spec/body routines | Oracle qualification | Open |
| Q2 | Real-task acceptance thresholds | Phase 6 decision | Open |

## Progress log

| Date | Phase | Note |
|---|---|---|
| 2026-10-20 | Phase 0 | Contract accepted; versioned policy documents removed; architecture references updated (`158c70d`). |
| 2026-10-20 | Phase 1 | Fact seam, report-only finalizer, TypeScript and Oracle lexical facts, and finalizer/adapter tests added. Persistence and tool contracts unchanged. |
| 2026-10-20 | Phase 2 | Added `publication-report`, P-1/P-2/P-3 prototypes, full measurement set, invariant classification, and aggregate corpus evidence. M1/M8/M9/M11/M12/M13/M14 resolved; accepted ceilings 2,000 addresses and 50,000 steps per root. Persistence unchanged. |
| 2026-10-20 | Phase 3 | Schema version 9 adds the normalized binding, site, origin, definition-site, and build-stat tables with enforced constraints and indexes. One `insertGenerationFacts` operation persists and validates complete fact sets while `building`; atomic publication and failed-candidate isolation are preserved. Adapter versions unchanged. |
