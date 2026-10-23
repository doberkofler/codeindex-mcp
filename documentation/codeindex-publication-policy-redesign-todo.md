# Publication Policy Redesign: Follow-up Work

Date: 2026-10-21

This file tracks unresolved work after implementation of the accepted
[publication-policy redesign](./codeindex-publication-policy-redesign.md). It is not
normative. Accepted facts, invariants, current tool contracts, qualification results, and
Q2 thresholds live in the policy document.

Do not restore the old phase-by-phase implementation transcript here. Completed status
and durable measurements have been merged into the policy.

## Current state

- The normalized fact model, adapters, schema version 9, finalization, persistence, and
  query migration are implemented.
- TypeScript G-A/G-A2 and the repository reference comparison pass.
- Oracle publication gates pass under the accepted omission policy; Oracle work is not
  part of this follow-up.
- Q2 v4 has 120/120 valid runs and 100% correctness in both arms, but fails all four
  efficiency gates: output 2.132x, calls +1 median, tokens 2.547x, p95 1.351x.
- The `v0.5.0` field trace predates the redesign. It is operational evidence, not a
  performance baseline for the new architecture.

## Constraints

- [ ] Keep every Q2 threshold unchanged.
- [ ] Never reinterpret the Q2 v4 failure as a pass.
- [ ] Keep private corpora, hidden cases, raw traces, model responses, and restricted results outside this repository; public synthetic cases and reviewed aggregate evidence may be committed.
- [ ] Run targeted diagnostics before another full campaign.
- [ ] Preserve the normalized fact model unless new semantic qualification disproves it.
- [ ] A replay or simulation can select a design; only the running implementation can
      satisfy an acceptance gate.
- [ ] Reuse raw extracted facts only. Never copy finalized context rows unless canonical
      full-build equivalence is proved for every affected table.

## Track A: deepen the reference query module

The current interface is shallow: callers resolve a name, copy an opaque symbol ID, call
`find_references`, and receive occurrence detail even when they need only paths. The
two-call workflow existed in `v0.5.0`; the richer redesign payload amplified its cost.

### A1. Decisions

- [ ] **D-A1:** Accept one-call name resolution in `find_references`. Recommended: yes.
- [ ] **D-A2:** Keep the existing `symbolId` selector default as flat occurrences for
      compatibility. Recommended: yes.
- [ ] **D-A3:** For the new `query` selector, default to file grouping. Recommended: yes.
- [ ] **D-A4:** Decide whether `index_status` gains `detail = summary | full`, with a
      summary budget of 600 bytes. Recommended: yes.

### A2. Contract

- [ ] Accept exactly one selector: `symbolId` or `query`. Both or neither returns
      `invalid_argument` naming both fields.
- [ ] Give `query` the same `match`, `kind`, `container`, `path`, `exposure`, and
      `context` semantics as `find_symbol`.
- [ ] Return a discriminated result:
  - `occurrences`: current flat result;
  - `files`: one item per path;
  - `owners`: one item per `(path, owner)`;
  - `ambiguous`: at most five compact candidates plus total;
  - `none`: indexing limitations and text-search fallback, never a source-absence claim.
- [ ] Add `group = file | owner | occurrence`. `query` defaults to `file`; `symbolId`
      defaults to `occurrence`.
- [ ] Count one occurrence per `(path, startOffset, role)` regardless of context-row
      count. A context filter restricts membership before grouping.
- [ ] For grouped modes, omitted `role` means `reference`. Preserve the current omitted
      role behavior—definitions plus references—for occurrence mode.
- [ ] Preserve current filters: `path`, `enclosingId`, `usage`, `role`, and `context`.
- [ ] Order file groups by path bytewise; owner groups by path, then owner ID, with null
      owner first. Bind cursors to generation, group, selector, filters, and keyset.
- [ ] Grouped items contain count, usage-mask union, at most eight context names, and a
      `contextsTruncated` flag. Null owner means top-level code.
- [ ] Always retain group totals, occurrence total, definition total, unclassified
      references, and `crossFileRefsObserved` under byte reduction.
- [ ] Add `kind: 'occurrences'` to the current response only after confirming every
      programmatic consumer accepts the additive field.
- [ ] `invalid_argument` returns at most five `{name, reason}` records using a closed
      reason enum; never echo values.
- [ ] `symbol_not_found` for `read_symbol` and `find_references` explains that symbol IDs
      are opaque and must be copied from `find_symbol` or `outline`.

### A3. Tests and diagnostic gate

- [ ] Unit tests: exclusive selectors, none/one/ambiguous resolution, exact candidate
      cap, null owner, distinct counting across contexts, role defaults, every filter,
      deterministic order, and grouped keyset cursors.
- [ ] Byte-bound tests: contexts drop first with `contextsTruncated`; trailing whole
      items drop next; totals remain; cursor resumes without duplicates or gaps.
- [ ] MCP protocol tests for schemas, discriminants, structured errors, and compact
      `index_status`.
- [ ] Run complete model-free no-index, accepted, and candidate routes and reject the
      architecture campaign if any route misses its exact answer or contract.
- [ ] Run the full three-treatment architecture campaign from scratch with the pinned
      frontier model after the model-free route passes. Local-model qualification is a
      separate fixed-artifact model test, not a candidate precondition.

## Track B: repair and strengthen the evaluation harness

- [ ] Store the exact tool-name list presented to the model for each treatment.
- [ ] Store turn-one token accounting separately from later tool-result turns.
- [ ] Invalidate a run when ordinary tools differ across treatments; accepted and
      candidate differ only by the CodeIndex artifact, and no-index omits CodeIndex.
- [ ] Remove generic `execute` from every treatment, or keep it identical and report every
      `Unknown tool` outcome. Native `codeindex_*` routing remains mandatory.
- [ ] Grade the exact expected file set. Extra files fail unless listed as explicit
      `contextFiles`; define and bound that allowance before adding cases.
- [ ] Expand to at least 18 cases and retain 5 paired repetitions.
- [ ] Add at least 6 mechanically admitted semantic cases. A case qualifies when the
      best single-identifier grep has file-set precision at most 0.5 or misses an
      expected file.
- [ ] Cover renamed re-exports, barrel chains, shadowed common names, implementations of
      an interface, type-only imports, and references through a default export.
- [ ] Report locate, impact, implementation, and semantic classes separately beside the
      unchanged overall verdict.
- [ ] Add paired-by-case bootstrap 95% intervals for every ratio.
- [ ] Do not report pooled “used index versus did not use index” comparisons; routing is
      class-confounded.
- [ ] Keep the gate token metric as uncached input + output + reasoning. Report cache-read
      tokens and cost separately.
- [ ] Run the full Q2 v5 three-treatment campaign only after Track A's model-free gate
      passes.

## Track C: establish the old-versus-new TypeScript baseline

### C1. Controlled architecture A/B

- [ ] Compare release `v0.5.0` (`25fe5ba`) and redesign commit `fed1b6e` on the same
      pinned TypeScript corpus, `tsconfig`, machine, Node version, and query workload.
- [ ] Run at least 10 cold full builds and 10 warm rebuilds per commit.
- [ ] Record scan, compiler, extraction, finalization, insertion, verification,
      publication, and total duration where available.
- [ ] Record peak RSS, database size, table/row counts, and extraction-artifact size.
- [ ] Run a fixed 200-query workload and separate core query latency, serialized MCP
      bytes, and full-agent metrics.
- [ ] For full-agent measurements, use one model, identical prompts, direct native MCP
      tools, and the same cases at both revisions. Record product-surface differences
      rather than hiding them.
- [ ] Record each commit's bundled TypeScript version. If versions differ, either run a
      compatible common compiler or name the compiler difference as a confound.
- [ ] Publish only aggregate, scrubbed results.

### C2. Live operational evidence

- [ ] Add telemetry before interpreting current field behavior: closed failure cause,
      per-context stages/RSS, merge/finalization duration, publication breakdown,
      cleanup duration, dirty-context count, and end-to-end time to fresh.
- [ ] Run the current revision on the LJS project for at least 8 active editing hours.
      Report separately from the historical `v0.5.0` field trace.
- [ ] Build a deterministic edit script using real files and the real watcher/builder.
      Every event changes content. Run it at both revisions.
- [ ] Explain or bound the historical hours-long event-to-success tail; do not substitute
      successful-publication latency, which has survivorship bias.

## Track D: build read consistency and failure recovery

Verified current behavior:

- `createVerifiedSourceFileRecord` rejects when disk text differs from compiler text.
- `insertContents` rereads disk and rejects when the hash differs.
- changes during a build set `refreshAgain`; successful publication schedules a
  debounced follow-up.
- the failure path records failure but does not reschedule pending `refreshAgain` work.

### D1. Design decisions

- [ ] **D-D1:** Accept compiler-observed read consistency, explicitly not an atomic
      workspace snapshot. Recommended: yes.
- [ ] **D-D2:** Decide failure retry policy and cap. Deterministic invariant/ceiling
      failures must not timer-retry.
- [ ] **D-D3:** Decide diagnostic retention. Analytics stores only a closed cause; do
      not remove bounded, sanitized operational diagnostics without an explicit decision.
- [ ] **D-D4:** Decide the p95 time-to-fresh target after the controlled baseline.

### D2. Implementation shape

- [ ] Add one per-build recording compiler host shared by all project contexts. The first
      read of a path fixes its text for that build.
- [ ] Record file text/hash, configuration reads, existence probes, directory probes, and
      module-resolution inputs needed to explain the compiler-observed read set.
- [ ] Persist recorded compiler text directly; do not reread authored files during
      content insertion.
- [ ] Derive the generation source hash from the recorded read set rather than the
      pre-build scan.
- [ ] A change after a read does not reject a generation. At publication it marks the
      path dirty; changed configuration or probe results mark structural staleness.
- [ ] Preserve `read_symbol` live-hash verification and stale-file refusal.
- [ ] After failure with pending `refreshAgain`, schedule one debounced follow-up under
      the accepted retry policy.
- [ ] Define a closed `BuildFailureCause` set. Keep `source_changed` for historical
      comparison; it must become zero after this work.

### D3. Acceptance

- [ ] Fault-inject source and configuration edits at the start, middle, and end of scan,
      compiler, extraction, insertion, verification, and publication.
- [ ] Prove every persisted content row equals parsed compiler text.
- [ ] Prove source edits mark dirty, structural edits mark stale, and the follow-up
      generation clears both.
- [ ] In the scripted edit run: zero `source_changed`; `unknown` at most 1%; all other
      failure causes together at most 5%.
- [ ] Repeat those counts in the live soak. A replay cannot satisfy this gate.

## Track E: shorten publication

Verified current behavior: `IndexDatabase.publish()` deletes superseded/failed
generations and orphan content inside the publication transaction before completing the
pointer change.

- [ ] Instrument each publication and cleanup step before changing behavior.
- [ ] Keep lease validation, generation-state changes, and current-generation pointer
      update in the publication transaction.
- [ ] Move destructive cleanup after commit; make it bounded, idempotent, and recoverable
      by a startup sweep.
- [ ] Preserve one superseded generation.
- [ ] Ensure cleanup never overlaps the next build's content insertion in a way that can
      delete newly inserted but not-yet-referenced content.
- [ ] Test a reader pinned to the previous generation during cleanup and a crash between
      publication and cleanup.
- [ ] Treat cleanup failure as telemetry, not candidate-build failure.
- [ ] Decide a publication p95 budget after the first controlled measurement; 500 ms is
      a proposal, not an accepted threshold.

## Track F: measure before adding reuse

Verified current behavior: TypeScript contexts are extracted separately into serializable
facts, then merged and finalized globally. Existing `extraction_artifact` rows are written
after full extraction, have no production read path, and omit publication facts.

- [ ] Measure extraction duration and peak RSS per context.
- [ ] Measure dirty contexts per refresh and merge/finalization duration.
- [ ] Determine whether compiler programs remain live together in practice; source scope
      alone does not prove peak-memory behavior.
- [ ] Decide whether context reuse has enough expected benefit to justify implementation.
- [ ] If implemented, cache raw per-context facts keyed by adapter/schema/compiler
      versions, compiler options, and a revalidated recorded-read-set hash.
- [ ] Always merge all context facts and rerun global finalization.
- [ ] Compare canonical database dumps from reused and full builds over edits to shared
      files, context-local files, configuration, and file existence. Ignore only
      generation IDs; symbol IDs and semantic rows must match.
- [ ] Do not design per-file reuse until context measurements show it is necessary.
      Type-dependent facts require dependency-closure invalidation, especially through
      barrels.

## Track G: compiler drift

- [ ] Emit `compiler_drift` once per `(extractor version, declared version)` pair per
      process, not once per refresh.
- [ ] Add compact `index_status.compilerDrift = {extractor, declared} | null`.
- [ ] **D-G1:** Keep drift visible rather than fatal. Recommended: yes.
- [ ] **D-G2:** Decide separately whether project-local TypeScript loading is pursued.
      Account for ESM/CJS loading, repository-code trust, supported versions, and full
      adapter qualification per version.

## Evidence and decision log

Record only new decisions and measurements here. Move durable accepted results into the
policy and remove completed checklist detail from this file.

| Date | Item | Result |
|---|---|---|
| 2026-10-21 | Q2 v4 | 120/120 valid; correctness passes; all efficiency gates fail |
| 2026-10-21 | Architecture comparison | `v0.5.0` versus `fed1b6e`: 53 changed files, +7,881/-990 lines, 16 to 22 tables; no controlled performance A/B |
| 2026-10-21 | Review A2 | Split interface/evaluation from build lifecycle; corrected snapshot, reuse, replay, and generic-tool claims |
