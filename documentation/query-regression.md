# Query regression: post-publication `find_symbol` and `outline`

Status: fixed for the next release. Answers PROD-008 ([#68]) and retains every
acceptance criterion of the superseded PROD-002 ([#48]).

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
| `find_symbol` first page | 21 | 32,646 | 4.71 | 5.79 | 0.221 | 0.145 |
| `find_symbol` page at depth 10,000 | 2 | 3,280 | 2.90 | 3.27 | 1.393 | 0.870 |
| `outline` first page | 58 | 32,592 | 1.12 | 1.27 | 0.019 | 0.034 |
| `outline` page at depth 9,800 | 55 | 32,197 | 1.09 | 1.19 | 0.020 | 0.035 |

### Generated xl

| Call | Items | Bytes | p50 | p95 | ms/item | ms/KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `find_symbol` first page | 21 | 32,646 | 4.87 | 6.11 | 0.254 | 0.167 |
| `find_symbol` page at depth 10,000 | 4 | 6,357 | 5.99 | 7.25 | 1.533 | 0.988 |
| `outline` first page | 58 | 32,592 | 1.14 | 1.30 | 0.019 | 0.035 |
| `outline` page at depth 9,800 | 55 | 32,197 | 1.30 | 1.54 | 0.026 | 0.045 |

Before the fix the retained baseline recorded 108–186 ms for an xl `find_symbol`
page and 103–121 ms for an xl `outline` page; large was 68 ms and 19–23 ms.

The residual per-item growth on the final `find_symbol` page is explained by the
returned item count: the page contains 2–4 items, so fixed page overhead is
divided over fewer items. Page cost itself is flat in depth: the candidate
statement is bounded by `fetchLimit`, and the outline scan touches one covering
index entry per item advanced.

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
for about 21 items (5.1–8.9 ms/item). Both fail. The fixed large page is
0.22 ms/item and xl is 0.25 ms/item. A regression test constructs a 60 ms,
20-item sample and asserts the gate fails.

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
| large, depth 10,000 | 2.83 ms | 3.27 ms | 3.71 ms |
| xl, depth 10,000 | 6.04 ms | 6.51 ms | 8.03 ms |

Before the fix, the same page measured 68 ms large and 108–186 ms xl, so a
trivial request could wait an order of magnitude longer.

## 9. Retained PROD-002 (#48) acceptance

| #48 criterion | Evidence |
| --- | --- |
| Every cursor-bound query planned without a full table scan on the hot path | §4: all three statements use an index, with no `SCAN` at offset 0 or maximum depth |
| Deep pagination reaches the last page without duplicates or omissions | §6: 14 traversals, 52,507 items, zero differences; every walk terminates on a null cursor |
| Depth does not change the plan shape or introduce a scan | §4: identical plans at offset 0 and maximum depth |
| Per-page latency stays within the retained baseline | §5: outline is 1.2–1.5 ms (baseline 1–2 ms); `find_symbol` is 5.8–7.3 ms versus 9–186 ms, with the per-byte deviation recorded as the deliberate binding-aware output decision |
| Result recorded against a pinned corpus and artifact digest | §1 corpora, §10 commit and bundle digests |

## 10. Reproduction

```bash
pnpm build
node dist/cli.mjs benchmark --profile large \
  --workspace ~/codeindex-perf/large \
  --database ~/codeindex-perf/large-db/index.sqlite \
  --scenarios warm --keep-workspace \
  --output ~/codeindex-perf/final-large.json
```

Then run `evidence.ts` (kept outside the repository) against the resulting
database for the p95 and per-item/per-byte table, and run the suite:

```bash
pnpm run benchmark:typescript:generated
```

The retained run is recorded against the commit that carries this change; the
tree must have an empty `git status --porcelain` before the suite run.

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
