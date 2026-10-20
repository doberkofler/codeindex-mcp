# Publication Policy Redesign: Implementation Progress

This file tracks implementation progress for
[codeindex-publication-policy-redesign.md](./codeindex-publication-policy-redesign.md).
It is not normative: policy, invariants, and tool contracts live in that document.
Update this file only for checkboxes, measurements, and dated progress notes.

Date: 2026-10-20

## Current phase

Phase 1: introduce the fact seam. Schema remains version 8; no redesigned facts are
persisted or published.

## Phase 0: accept the contract

Complete on 2026-10-20 (commit `158c70d`).

- [x] Policy approved as the sole publication-policy source.
- [x] Scoped projection and three-valued exposure accepted.
- [x] Canonical binding-key encoding accepted.
- [x] Open items assigned to measurement, phase, or deferred scope.
- [x] Versioned `codeindex-publication-policy-v*.md` documents removed.
- [x] `documentation/architecture.md` points to the policy.

## Phase 1: introduce the fact seam

- [ ] Define the serializable extracted fact bundle (`files`, `symbols`, `bindings`,
      `bindingContexts`, `bindingSites`, `surfaceOrigins`, `occurrences`,
      `dependencies`, `adapterStats`, `diagnostics`, `compilerMs`, `extractionMs`) at
      the `ExtractorType.build()` seam.
- [ ] Add one `finalizeFacts(facts, policy)` entry point under `src/core/facts/` with
      `mode: 'enforce' | 'report'`.
- [ ] Keep existing persistence, schema version 8, and tool responses unchanged.
- [ ] Run classification report-only inside the build worker.
- [ ] Confirm both adapters emit bounded in-memory facts without compiler or parser
      objects crossing the seam.
- [ ] Add pure finalizer tests: canonical JSON, UTF-8 ID framing, deterministic
      ordering, primary/anchor selection, exposure derivation, duplicate rejection, and
      synthetic collision failure.
- [ ] Confirm adapter, finalizer, and config-hash boundaries with a review pass.

## Phase 2: dry run and prototypes

- [ ] Add a report-only qualification entry point that never persists or publishes.
- [ ] P-1: G-A/G-A2 declaration-emission truth on the TypeScript corpus.
- [ ] P-2: compiler export-table prototype for external aliases and CommonJS.
- [ ] Run every required measurement below.
- [ ] Classify every S3, O2, L1, and F1 violation into complete named classes.
- [ ] Record proposed per-root ceilings and headroom.
- [ ] Record P-1/P-2 outcomes in the policy document and this file.

| ID | Measurement | Status | Result |
|---|---|---|---|
| M1 | Named nested TypeScript functions: count, total lines, p95 extent lines | Not started | |
| M2 | JavaScript and CommonJS files in indexed roots | Not started | |
| M4 | Definition-site count and bindings-per-symbol distribution | Not started | |
| M6 | Surface addresses per root, reachability steps per root, runtime, peak memory | Not started | |
| M7 | Oracle cursor pairs, call specs, polymorphic table functions, routine pairs, ambiguity rate, overload groups, body forwards, body-less spec classification | Not started | |
| M11 | Maximum reachability steps per root and proposed ceiling | Not started | |
| M12 | Surface bindings per root/symbol, maximums, share by `anonymous`, `inherited`, `depth1` | Not started | |
| M13 | Union/intersection projection cases and selected semantics | Not started | |
| M14 | Merged TypeScript symbols by declaration-kind set and fixed precedence effect | Not started | |
| R1 | Persistence × exposure × kind, occurrence role/usage/owner, source lines | Not started | |
| R2 | S3, O2, L1, F1 violations grouped into named classes | Not started | |

Report artifacts contain aggregate values only. A separate local diagnostic artifact may
contain workspace-relative paths, offsets, opaque IDs, and category names; never source
text, query text, credentials, or absolute paths.

### Evidence checkpoint

- [ ] Every item marked "Resolve before DDL" has a recorded measurement or decision.
- [ ] Every schema-shaping case has an explicit rule in the policy.
- [ ] DDL work explicitly approved.

Do not start Phase 3 before this checkpoint is complete.

## Phase 3: schema and persistence

- [ ] Bump `SCHEMA_VERSION`.
- [ ] Bump each adapter version whose emitted facts change.
- [ ] Add normalized tables, columns, foreign keys, and indexes.
- [ ] Persist complete fact sets through one storage operation.
- [ ] Validate while the generation is `building`.
- [ ] Preserve atomic publication and failed-candidate isolation.
- [ ] Temporary-database tests: FK integrity, deterministic IDs, collision failure,
      failed-candidate isolation, same-generation status counts.

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
| M1 | Store named nested TypeScript functions | Resolve before DDL | Open |
| M5 | Default `find_symbol` exposure | Phase 6 decision | Open |
| M8 | Oracle synonym/current-schema source and case folding | Resolve before DDL | Open |
| M9 | `find_references` grouping and pagination semantics | Resolve before DDL | Open |
| M10 | Oracle/ORDS scope and cross-language edges | Deferred scope | Deferred |
| M11/M12 | Reachability-step and surface-address ceilings | Resolve before DDL | Open |
| M13 | Union/intersection projection semantics | Resolve before DDL | Open |
| M14 | Merged TypeScript declaration-kind precedence | Resolve before DDL | Open |
| Q1 | PL/Scope signature equality for packaged spec/body routines | Oracle qualification | Open |
| Q2 | Real-task acceptance thresholds | Phase 6 decision | Open |

## Progress log

| Date | Phase | Note |
|---|---|---|
| 2026-10-20 | Phase 0 | Contract accepted; versioned policy documents removed; architecture references updated (`158c70d`). |
