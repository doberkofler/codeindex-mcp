# Product Roadmap

## 1. Product direction

CodeIndex MCP is a language-neutral indexing platform, not a TypeScript-only
product. Each source language or external semantic system is an adapter. The core
owns identity, immutable content, generations, storage, publication, freshness,
bounds, evidence, and queries.

The current TypeScript/JavaScript implementation is the first production slice.
Oracle SQL, PL/SQL, and ORDS are the next major slice. Additional languages follow
the same adapter contract and require separate evidence-backed delivery decisions.

“Supports all source code” means the architecture admits adapters; it does not
mean unknown languages receive compiler-quality semantics automatically.

## 2. Delivery principles

- Deliver one useful layer at a time and gate the next layer on measured quality.
- Preserve raw source identity; treat every index as disposable derived data.
- Prefer compiler/dictionary facts over patterns.
- Keep edge propositions separate from supporting evidence.
- Report unresolved and ambiguous sites instead of guessing.
- Add runtime collection only for measured static gaps.
- Add full-text or semantic recall only after measured symbol/lexical recall gaps.
- Never trade correctness, privacy, or freshness for feature breadth.

## 3. Phase T — TypeScript/JavaScript hardening

Detailed shipped behavior, pilot status, and enhancement ownership are maintained
in [TypeScript and JavaScript adapter](./typescript-adapter.md).

Remaining work is evidence-driven:

- maintain 100% precision and at least 99.5% reference recall on a deterministic,
  stratified sample of at least 200 symbols;
- retain compiler-version drift detection;
- verify hot SQLite query plans and deep pagination;
- ~~measure direct MCP and Code Mode overhead separately~~ — done; direct MCP
  remains recommended at `1.307` Code Mode cost (upper `1.473`), see
  [Exposure evidence](../evaluation/audits/exposure-eval-050.md);
- add incremental compiler state only if full-generation refresh misses its gate;
  **done** — per-file parse-digest fact reuse and per-path revision deltas closed
  the one-file edit-to-fresh gate (see below);
- add binding-aware façade analysis only when module reachability is insufficient;
- create controlled cases for dependency usage and impact.

Incremental work must still publish a complete immutable generation. It must never
mutate the currently published generation.

## 4. Phase O1 — Static Oracle source

Deliver the SQL and PL/SQL source-unit splitter, exact raw ranges, conservative
declarations, manifest/include resolution, diagnostics, and unresolved sites.

Gate: all splitter invariants pass on one-unit, multi-unit, malformed, quoting,
comment, SQL*Plus, and generated-source fixtures.

**Current status (2026-10-27): PASS.** The splitter and declaration surface pass
on the controlled corpus. The production replacement corpus passes every
`oracle-o1@4` gate: declarations, reference precision and recall, and package
dependency precision and recall. Contract `@4` defines the 103
`compiler_inferred_dependency` exclusions that closed
[#101](https://github.com/doberkofler/codeindex-mcp/issues/101). The current
evidence is in
[`benchmark/oracle-production-20261027`](../benchmark/oracle-production-20261027/README.md).
The 2026-10-25 and 2026-10-26 bundles and the historical Phase 0/6/8 reports are
comparisons, not the current verdict. The production `structural@5` performance
baseline is retained in
[`benchmark/oracle-performance`](../benchmark/oracle-performance/README.md);
cold build, reuse, rebuild, queries, resources, storage, and bundles pass their
declared gates, while one-file edit-to-fresh fails at a 22.1 s median against a
15 s failure threshold.

## 5. Phase O2 — Oracle dictionary

Deliver read-only `USER_*`, `ALL_*`, and optionally `DBA_*` modes; objects,
routines, overloads, arguments, dependencies, synonyms, schema structures,
compiler settings, and live source digests.

Gate: at least 95% precision on a reviewed source/live mapping sample; every
failure remains queryable; no database write occurs.

## 6. Phase O3 — PL/Scope experiment

Run the exact gate in [Oracle adapter](./oracle-adapter.md). Enable PL/Scope facts
only when semantic coverage, compile behavior, validity, time, and storage pass.
Otherwise publish explicit unavailable coverage and continue with static and
dictionary facts.

Current outcome (2026-10-25): PL/Scope truth can be regenerated, but the
production replacement corpus is **NOT READY** because references and package
dependencies miss the contract gates. Static and dictionary facts remain the
shipping surface; PL/Scope stays a qualification input.

## 7. Phase D — Source/database drift

Deliver versioned semantic normalization, mapping, complete drift states, and
optional deployment-provenance import.

Gate: fewer than 5% false-positive `diverged` results on a reviewed sample; every
direction claim has deployment evidence; ambiguity remains explicit.

## 8. Phase R — ORDS routes

Deliver checked-in route extraction, optional live ORDS metadata, authorization
facts, handler/routine candidates, and route drift where both sources exist.

Gate: representative exact routes round-trip from configuration to Oracle target;
secrets and request values never enter persisted facts.

## 9. Phase X — Cross-language graph

Deliver application-call, endpoint, route, ORDS, authorization, Oracle object,
and routine edges plus bounded impact traversal.

Gate: at least 95% precision for `exact` and 90% for `high` evidence on a reviewed
sample; unresolved/ambiguous ratios reported per adapter; no exact endpoint edge
without route and Oracle validation.

## 10. Phase E — Controlled evaluation

At every major phase, compare fixed tasks with and without the new index facts.
The primary gate is lower retrieval payload with equal or better correctness and
no material latency regression. Stochastic arms require repeated runs.

If a phase fails, improve its bounded interface or extractor. Do not hide weak
evidence or proceed merely because the data can be collected.

## 11. Phase L — Additional languages

A new language supplies:

- project/workspace discovery;
- source-file selection and configuration hashing;
- declarations, occurrences, relationships, and diagnostics;
- stable repository-relative locators and exact source ranges;
- documented limitations and fixture corpus;
- precision/recall or parser-corpus acceptance evidence.

It must not add language conditionals to storage, publication, pagination,
freshness, or MCP envelopes.

## 12. Optional recall

Evaluate shaped lexical search, then SQLite FTS, then local embeddings only when
controlled tasks show relevant files are missed by symbol, dependency, route, and
bounded lexical retrieval. Adoption requires measured recall gain and acceptable
latency, storage, privacy, and operational cost.

## 13. Stop rules

| Risk | Required response |
| --- | --- |
| Agents ignore index tools | Improve descriptions and workflow before adding facts |
| Extractor differs from language authority | Stop, classify mismatch, or replace extractor |
| Static PL/SQL splitting is inaccurate | Preserve unresolved ranges; strengthen parser only from failures |
| PL/Scope is empty or destabilizes builds | Disable it and report unavailable coverage |
| Dynamic dispatch dominates | Rank residue; add narrow runtime evidence only |
| Drift direction is unproven | Return `diverged`, never guess |
| Cross-language precision is poor | Hide weak evidence by default and stop expansion |
| Storage or refresh cost is unbounded | Enforce retention; deepen incrementality behind the same interface |
| Evaluation shows no benefit | Stop at the last useful phase |

## 14. Open decisions

These require prototypes and measurements:

- Oracle privilege model and supported dictionary modes;
- static parser strategy beyond the splitter/tokenizer;
- PL/Scope compile cost, storage cost, and semantic coverage by Oracle version;
- normalization rules and false-positive drift rate;
- portable deployment-provenance ingestion;
- supported ORDS versions and metadata sources;
- exact overload behavior for each ORDS dispatch mode;
- acceptable unresolved ratios for dynamic endpoint and SQL patterns;
- graph schema evolution and retention bounds;
- whether existing lexical tools remain sufficient;
- which language adapter follows Oracle/ORDS.

Each decision belongs to the first phase that needs it. None may be decided by
silently hardcoding one consumer's layout.

## 15. Technology decisions

| Technology | Decision |
| --- | --- |
| SQLite with WAL and strict tables | Retain as local, disposable, transactional semantic store |
| Node SQLite API | Prefer while it meets portability and performance gates |
| TypeScript compiler API | Retain for compiler-backed TypeScript/JavaScript facts |
| SCIP | Optional interchange/diagnostic format only after producer output validates |
| Oracle dictionary views | Authoritative live metadata within proven privileges |
| PL/Scope | Gated optional evidence, never assumed available |
| Custom SQL and PL/SQL unit splitter | Initial static-source boundary for undeployed and multi-unit scripts |
| Full PL/SQL grammar/ANTLR | Adopt only when measured failures justify compatibility and performance cost |
| Existing lexical tools | Keep as bounded fallback before adding another persistent index |
| SQLite FTS | Optional after measured lexical ranking/latency need |
| Embeddings/vector index | Deferred until controlled evidence shows semantic recall deficiency |
| External graph server | Reject initially; bounded SQLite traversal is sufficient |
| Hosted code search | Reject by default because it adds operations and source-disclosure risk |
