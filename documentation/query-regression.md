# Query regression: post-publication `find_symbol` and `outline`

Status: fixed for the next release. Answers PROD-008 ([#68]) and retains every
acceptance criterion of the superseded PROD-002 ([#48]). TEST-009 adds the
planner-statistics lifecycle, repair, and page-first regression coverage in §12.

The publication/binding refactor replaced index-ordered, `LIMIT`-bounded
statements with statements that materialized and hydrated a whole candidate or
file set on every page. `find_symbol` and `outline` regressed by 12–100× on the
retained corpora. This page records the measured cause, the change, the
before/after values, the plan captures, the output-equivalence proof, and the
new gate.

## 1. Corpora

| Corpus | Files | Symbols | Source |
| --- | ---: | ---: | --- |
| generated large | 2,704 | 28,207 | `benchmark/suites/typescript-generated.json`, profile `large` |
| generated xl | 10,504 | 122,507 | same suite, profile `xl` |
| `typescript` | pinned `050880ce59e30b356b686bd3144efe24f875ebc8` | - | `benchmark/suites/typescript-public.json` |
| `vscode` | pinned `072586267e68ece9a47aa43f8c108e0dcbf44622` | - | same suite |
| `material-ui` | pinned `28eadba9ec2899226ecbf4058b8fba1ddeab9e6d` | - | same suite |

Cursor measurements use `pageLimit: 200`, `maxDepth: 10,000`, and the production
32 KiB result bound. Generated corpora are deterministic; the marker file records
the expected counts.

## 2. Measured cause

### `find_symbol`

Each page fetched up to 10,000 candidates, joined `symbol` for every candidate,
hydrated binding contexts, binding sites, and definition sites for every
candidate symbol, built every item, sorted every item in JavaScript, and only
then sliced the page. The page itself was never the unit of work.

Large corpus, query `feature`, 4,020 candidates for the first page:

| Stage | Before | After |
| --- | ---: | ---: |
| Candidate statement | 24.7 ms | 1.7 ms |
| Binding details (all candidates → page) | 24.5 ms | 0.10 ms |
| Definition sites (all candidates → page) | 15.3 ms | 0.06 ms |
| Symbol summaries (page only) | - | 0.05 ms |
| Whole first page | 66.7 ms | 4.2 ms |

The candidate statement also planned as `MULTI-INDEX OR`, joined `symbol` before
`LIMIT`, and ran a correlated exposure subquery plus a declared-site `EXISTS` for
every candidate, with two temporary B-trees.

### `outline`

The page statement joined `definition_site` and `occurrence`, grouped by symbol,
and ordered by `min(o.start_offset)` before applying `LIMIT`. It therefore read
and sorted every definition in the file (10,000 rows large, 50,000 rows xl) on
every page, with `GROUP BY` and `ORDER BY` temporary B-trees. `occurrence` was the
driving table, so the join ran backwards from the symbol page.

After the fix the page is read from `definition_site` by path in `start_offset`
order using one covering index; symbol summaries, contexts, and sites are loaded
for the emitted page only.

## 3. Change

- Schema 10 adds derived, publication-owned columns:
  `symbol_name.exposure`, `symbol_name.has_declared_site`, and
  `definition_site.first_in_symbol`.
- New indexes:
  - `symbol_name_by_name (generation_id, name, container, binding_id, symbol_id, exposure, has_declared_site, qualified_name)`
    — covers the candidate statement, including ordering.
  - `definition_site_by_path (generation_id, path, first_in_symbol, start_offset, symbol_id)`
    — covers outline paging in output order.
  - `symbol_name_site_by_path (generation_id, path, kind, start_offset)` —
    filters outline re-exports in the index instead of scanning every site in the
    path.
- `find_symbol` ranks candidates from the statement's own columns. It no longer
  joins `symbol` or hydrates details before pagination; the page's symbols,
  contexts, bindings, and definition sites are loaded once, after the slice.
- `outline` pages over `definition_site.first_in_symbol = 1`; the first site per
  symbol and path is computed during publication from the finalized, ordered
  occurrence list.
- Benchmark plan captures now explain the production statements
  (`bindingCandidateQuery`, `outlinePageQuerySql`, `referencePageQuery`), not
  hand-maintained copies.

## 4. Plan captures

Generated xl, offset 0 and maximum depth; the shape is identical at both.

| Statement | Plan | Temporary B-tree |
| --- | --- | --- |
| `find_symbol` candidate | `SEARCH n USING COVERING INDEX symbol_name_by_name (generation_id=? AND name>? AND name<?)` | no |
| `outline` page | `SEARCH d USING COVERING INDEX definition_site_by_path (generation_id=? AND path=? AND first_in_symbol=?)` | no |
| `find_references` page | `SEARCH o USING INDEX sqlite_autoindex_occurrence_1 (generation_id=? AND symbol_id=?)`, `SEARCH s USING INDEX sqlite_autoindex_symbol_1 (generation_id=? AND id=?) LEFT-JOIN` | no |

Before, `outline` planned as:

```text
SEARCH o USING INDEX occurrence_by_extent (generation_id=? AND path=? AND role=?)
SEARCH d USING INDEX definition_site_by_occurrence (generation_id=? AND symbol_id=? AND path=? AND start_offset=?)
SEARCH s USING INDEX sqlite_autoindex_symbol_1 (generation_id=? AND id=?)
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

and the candidate statement planned as `MULTI-INDEX OR` with a `symbol` join
before `LIMIT`, two correlated subqueries, and two `USE TEMP B-TREE FOR ORDER BY`
steps.

## 5. Page size, byte efficiency, and latency

Every page is byte-budgeted, so the effective page is 21–23 `find_symbol` items
and 55–58 outline items rather than the requested 200. The byte budget, not the
row limit, terminates the page in every measurement. Values are p95 over 50
samples after warm-up; per-item and per-KiB use the last page's own items/bytes.

### Generated large

| Call | Items | Bytes | p50 | p95 | ms/item | ms/KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `find_symbol` first page | 21 | 32,646 | 4.72 | 5.51 | 0.248 | 0.163 |
| `find_symbol` page at depth 10,000 | 2 | 3,280 | 2.79 | 3.16 | 1.365 | 0.852 |
| `outline` first page | 58 | 32,592 | 1.10 | 1.18 | 0.019 | 0.035 |
| `outline` page at depth 9,800 | 55 | 32,197 | 1.09 | 1.22 | 0.020 | 0.034 |

Whole walk: `find_symbol` 1,168 ms for 239 pages and 5,000 items; `outline`
241 ms for 182 pages and 10,000 items.

### Generated xl

| Call | Items | Bytes | p50 | p95 | ms/item | ms/KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `find_symbol` first page | 21 | 32,646 | 4.74 | 5.52 | 0.219 | 0.144 |
| `find_symbol` page at depth 10,000 | 4 | 6,357 | 6.01 | 6.89 | 1.463 | 0.943 |
| `outline` first page | 58 | 32,592 | 1.15 | 1.26 | 0.020 | 0.036 |
| `outline` page at depth 9,800 | 55 | 32,197 | 1.29 | 1.53 | 0.025 | 0.044 |

Whole walk: `find_symbol` 4,139 ms for 477 pages and 10,000 items; `outline`
1,569 ms for 909 pages and 50,000 items.

### Retained suite samples

The clean-tree generated suite (`~/codeindex-evidence/prod-008-20261024`) records
one first-page sample per cursor statement and the gate result:

| Corpus | `find_symbol` first | ms/item | `outline` first | `deep_cursor` wall | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| large | 6.58 ms | 0.313 | 2.48 ms | 2,015 ms | pass |
| xl | 8.56 ms | 0.408 | 3.08 ms | 5,437 ms | pass |

The pre-fix `deep_cursor` scenario wall was 24,399 ms large and 114,699 ms xl.

### Attribution after the fix

Large first page:

| Stage | Cost |
| --- | ---: |
| Candidate statement (4,020 rows, covering index) | 1.68 ms |
| Symbol summaries for the page | 0.05 ms |
| Binding details for the page | 0.10 ms |
| Definition sites for the page | 0.07 ms |
| JavaScript dedupe, `localeCompare` sort, byte-budget search, serialization | 2.29 ms |
| Whole first page | 4.33 ms |

Outline first page:

| Stage | Cost |
| --- | ---: |
| Page query, symbol summaries, and site selection (`outlineSymbols`) | 0.97 ms |
| — symbol summaries and contexts inside that call | 0.38 ms |
| — definition-site and occurrence join inside that call | 0.48 ms |
| Re-export scan (covered by `(path, kind)`) | 0.01 ms |
| Serialization and file check | 0.13 ms |
| Whole first page | 1.11 ms |

Before the fix, the same large page measured 24.7 ms candidate, 24.5 ms binding
details, 15.3 ms definition sites, and 66.7 ms whole; the outline read and sorted
the whole file in 15.4 ms.

The residual per-item growth on the final `find_symbol` page is explained by the
returned item count: the page contains 2–4 items, so fixed page overhead is
divided over fewer items. Page cost itself is flat in depth: the candidate
statement is bounded by `fetchLimit`, and the outline scan touches one covering
index entry per item advanced.

For comparison, the v0.3.0 large page (3 ms for a 32 KiB page) was about
0.09 ms/KiB; the binding-aware page is 0.145–0.18 ms/KiB, a 1.6–2× per-byte
deviation recorded as a deliberate product tradeoff rather than a regression.
The xl page is 0.167 ms/KiB against about 0.28 ms/KiB for the 9 ms v0.3.0 page.

### Public projects

Pinned checkouts from `typescript-public.json`. The broad query is derived from
the busiest file's first symbol; these project files expose narrower prefixes
than the generated corpora.

| Project | Files | Symbols | Query | `find_symbol` items | p95 | ms/item | `outline` items | p95 |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| `typescript` `050880ce` | 77 | 17,028 | `Pat` | 4 | 0.31 ms | 0.039 | 51 | 1.65 ms |
| `material-ui` `28eadba9` | 1,063 | 6,942 | `Com` | 9 | 0.67 ms | 0.025 | 45 | 1.66 ms |
| `vscode` `07258626` | - | - | - | - | - | - | - | - |

VS Code still fails before measurement with the known worker heap limit; with
an enlarged heap it fails the persisted `length(name) > 0` constraint on the
empty-string member documented in
[Reference-workstation baseline §5](./reference-baseline.md#vscode-failure). That
is a corpus/model limitation, not this regression.

The retained baseline recorded `find_symbol` p95 of 10 ms for `typescript` and
7–9 ms for `material-ui`; `outline` was not separately retained for the public
projects.

## 6. Output equivalence

The schema-9 database was built from commit `b883a0c` with the pre-fix code; the
schema-10 database was built from the fixed code on the same deterministic large
corpus. Fourteen traversals were compared page by page, ignoring only
generation identity, the freshness timestamp, and the generation component of
the cursor:

- `find_symbol` for `feature`, `outline`, `hubSymbol`, and no-match prefixes,
  with `visible`, `published`, and `any` exposure, `kind`, `container`, `path`,
  and `context` filters, and name/qualified matching;
- `outline` with no kind filter and with a kind filter.

Result: **52,507 items, 0 differences**, including item order, matched and
primary bindings, other names, sites, truncation flags, and page boundaries.

## 7. Gate

Deep-cursor samples now record `items` and `bytes`. The evaluation adds:

| Gate | Warning | Failure |
| --- | ---: | ---: |
| `absolute.cursor.find_symbol.item` (ms per returned item, page-sized samples) | 0.75 | 1.5 |

The pre-fix large page was 68 ms for 21 items (3.2 ms/item); xl was 108–186 ms
for about 21 items (5.1–8.9 ms/item). Both fail. The fixed clean-suite samples
are 0.313 ms/item large and 0.408 ms/item xl (0.22–0.25 ms/item in the
50-sample probe). A regression test constructs a 60 ms, 20-item sample and
asserts the gate fails.

The `queries` scenario no longer uses `query: 'a'`, `limit: 10`; it derives a
three-character prefix from the corpus and requests a 200-item page, so the
recorded p95 exercises candidate ranking and byte truncation.

## 8. MCP responsiveness

Queries run synchronously on the MCP process. A trivial request issued while a
deep page runs is therefore queued for at most the page duration. Measured by
scheduling an immediate timer and running the deep `find_symbol` page before
yielding, the queued request delay is:

| Corpus | p50 | p95 | Max |
| --- | ---: | ---: | ---: |
| large, depth 10,000 | 2.85 ms | 3.44 ms | 3.89 ms |
| xl, depth 10,000 | 6.19 ms | 9.25 ms | 9.57 ms |

Before the fix, the same page measured 68 ms large and 108–186 ms xl, so a
trivial request could wait an order of magnitude longer.

## 9. Retained PROD-002 (#48) acceptance

| #48 criterion | Evidence |
| --- | --- |
| Every cursor-bound query planned without a full table scan on the hot path | §4: all three statements use an index, with no `SCAN` at offset 0 or maximum depth |
| Deep pagination reaches the last page without duplicates or omissions | §6: 14 traversals, 52,507 items, zero differences; every walk terminates on a null cursor |
| Depth does not change the plan shape or introduce a scan | §4: identical plans at offset 0 and maximum depth |
| Per-page latency stays within the retained baseline | §5: outline is 1.2–1.5 ms (baseline 1–2 ms); `find_symbol` is 5.5–6.9 ms versus 9–186 ms, with the per-byte deviation recorded as the deliberate binding-aware output decision |
| Result recorded against a pinned corpus and artifact digest | §1 corpora, §10 commit and bundle digests |

## 10. Retained evidence and reproduction

The clean-tree run is retained at `~/codeindex-evidence/prod-008-20261024`
(manifest, summary, per-step JSON/Markdown/evaluation reports, logs, and
`checksums.sha256`). Identity:

| Field | Value |
| --- | --- |
| Commit | `c0816f5e46bee4be08a722f0069b34a97aa9625c` |
| Tree | clean (`dirty: false`, empty status digest) |
| Suite digest | `bad3b2bef0ea1e875451e6f2d0dad6241092e38179bf829d279f30b1482331f5` |
| CLI bundle SHA-256 | `6766933f4af9e03cb02ca2c2c29b57fa0a61dd2a2b364fbd8f76a578e0529b0d` |
| Result | passed; large run 01/02 and xl run 01 |

The equivalence dumps, comparison result, per-corpus probes, probe source, and
`checksums.sha256` are retained at `~/codeindex-evidence/prod-008-query`. The
comparison summary digest is
`2da1c0d9840f39c746d3e10d29a6190bb0acad35c0b3ce2048f0708b45a5e44a`.

```bash
pnpm build
node dist/cli.mjs benchmark-suite \
  --suite benchmark/suites/typescript-generated.json \
  --output ~/codeindex-evidence/prod-008-20261024
```

The per-corpus probe (first/deep p95, whole walk, attribution, per-item and
per-byte cost, queued-request delay) is run against an already-published
database:

```bash
node --experimental-strip-types ~/codeindex-evidence/prod-008-query/evidence.ts \
  "$HOME/codeindex-perf/large-db/index.sqlite" \
  "$HOME/codeindex-perf/large" \
  large
```

The tree must have an empty `git status --porcelain` before the suite run.

## 11. Limitations

- Offset pagination still advances the outline covering index by `offset` rows.
  The measured cost is 0.17 ms at 10,000 items and 1.2 ms at 49,000 items on xl;
  it is offset work, not a scan or a sort.
- The per-item `find_symbol` gate excludes pages with fewer than 10 returned
  items, where fixed overhead dominates and the item count no longer represents
  the work.
- A rebuild publishes from a worker thread; the query path only reads the
  published generation. Concurrency with publication is covered by the existing
  publication tests, not by a new latency claim here.

## 12. Statistics lifecycle and pull-request regression coverage

TEST-009 closes the verification gaps left by the page-first change.

### Required statistics

`src/core/storage/databaseStatistics.ts` no longer accepts a database merely
because `sqlite_stat1` exists. It names every index the hot statements depend on
and re-runs `ANALYZE` on open when any non-empty table is missing its row. The
required set covers:

- `find_symbol`: `symbol_name_by_name`, `symbol_name_by_symbol`,
  `sqlite_autoindex_symbol_name_context_1` and `symbol_name_context_by_exposure`;
- `outline`: `definition_site_by_path`, `definition_site_by_occurrence` and
  `sqlite_autoindex_symbol_name_site_1`;
- `find_references`: `sqlite_autoindex_occurrence_1` and
  `sqlite_autoindex_occurrence_context_1`;
- symbol hydration: `sqlite_autoindex_symbol_1`.

`publish` still refreshes all estimates inside the publication transaction, so
initial build, forced rebuild, and watcher refresh share one lifecycle.

### Lifecycle and repair coverage

`test/storage.test.ts` covers an empty database, first publication,
small-to-large replacement, forced rebuild, and watcher-style publication, and
asserts every required statistic equals its table's row count. It also deletes
selected statistic rows (not the whole table) and proves `IndexDatabase.open`
restores them before the first query. `test/database.test.ts` covers derived
`exposure`, `has_declared_site`, and `first_in_symbol` values, and keeps one
reader open while a separate Node process publishes a larger generation; the
surviving reader then plans all three hot statements without a `SCAN` or
temporary B-tree.

### Red-capable page-first checks

`test/database.test.ts` also owns the two structural regressions:

- `find_symbol` builds 1,200 candidates and asserts that symbol summaries,
  binding details, and definition sites receive only the five emitted page
  identifiers. Hydrating every candidate fails with a stage label such as
  `find_symbol.binding_details`.
- `outline` uses the production `outlinePageQuerySql` builder at offset 0 and
  the maximum depth, asserts the `definition_site_by_path` plan, and executes
  the statement against a file with two definitions for one symbol. Dropping
  `first_in_symbol` fails with `outline.page.plan.offset.0` and
  `USE TEMP B-TREE FOR ORDER BY`; reading all sites fails on
  `outline.page_rows.offset.0`.

Both checks were verified by temporarily reverting the corresponding page-first
condition; each failed with the named stage, not a latency threshold.

### Pull-request benchmark decision

No new timing benchmark is added to `verify:pr`. The structural checks above run
inside the existing `test` step and fail deterministically when page work
regresses; a wall-clock sample over a generated corpus remains nightly and
stable coverage, where cardinality, machine variance, and retained references
are already controlled. The existing `verify:pr` budget stays at 120 s. The
three affected test files measured 0.91 s in a focused run, and the complete
`verify:pr` measurement remains recorded in
[Codebase testing strategy §6](./codebase-testing-strategy.md#6-target-workflows).
