# Reference-workstation baseline

Status: retained 2026-10-24 for `codeindex-mcp` 0.6.0 at commit
`b883a0c7790a4b1ae2bce0ae7bcf446cec044e71`.

This page records the machine, runtime, artifact identity, measured values,
declared gates, retained evidence digest, and reproduction commands for the
model-free reference baseline. It answers PROD-001 ([#47]). The baseline is a
fixed-corpus measurement, not a population or agent-task claim.

Stable and nightly verification now run on the pinned GitHub-hosted
`ubuntu-24.04` image. This page remains the retained Apple M5 Max record for
`0.6.0`; it is not the current verification platform, and its numbers are not
comparable with Linux runs.

## 1. Machine and runtime

| Field | Value |
| --- | --- |
| Machine | Apple M5 Max, 64 GiB |
| OS | macOS 27.0.1 (build 26A434) |
| Platform / architecture | `darwin` / `arm64` |
| Node.js | `v26.10.0` |
| pnpm | `12.15.0` |
| SQLite | `3.53.4` |
| CodeIndex version | `0.6.0` |
| Commit | `b883a0c7790a4b1ae2bce0ae7bcf446cec044e71` |
| CLI digest | `346cb4f668c58ff7d3907e0b91aea455a4ab1b4edab91b741902830090bb819d` |
| MCP digest | `6924261336d4cec93563a89901ddf649803b3f053f693a76a561d03806b5569a` |
| Generated suite digest | `bad3b2bef0ea1e875451e6f2d0dad6241092e38179bf829d279f30b1482331f5` |
| Public suite digest | `8813bfbb409784751e833e6a0ab890333fb753816cb32837fdfc74fe45b38324` |

The baseline was produced from a clean checkout (`git status --porcelain` empty)
with the bundles built by `pnpm build`. It is the post-release `0.6.0` source,
not the exact certified artifact `ac846e44…`; cost claims from the final
certification remain scoped to that artifact.

## 2. Declared gates

The gates below were committed before this measurement. The first run has no
reference report, so relative regression gates are skipped until this report is
supplied as `--reference`. Absolute gates and deep-cursor plan checks always
apply.

| Dimension | Gate | Source |
| --- | --- | --- |
| Build, rebuild, edit, query | warning above 2× reference, failure above 5× reference | `benchmark/baseline*.json` |
| RSS, CPU, storage | warning above 2× reference, failure above 4× reference | `benchmark/baseline*.json` |
| Gate slack | 50 ms latency, 5 ms query, 64 MiB memory, 100 ms CPU, 16 MiB storage | `benchmark/baseline*.json` |
| Edit-to-fresh p95, generated large | warning above 5 s, failure above 15 s | `benchmark/baseline.json` |
| Edit-to-fresh p95, generated xl | warning above 20 s, failure above 40 s | `benchmark/baseline-xl.json` |
| Query p95, generated | warning above 25 ms, failure above 100 ms | `benchmark/baseline.json` |
| Query p95, external | warning above 250 ms, failure above 1000 ms | `benchmark/baseline-external.json` |
| One-file freshness | p95 ≤ 15 s | [Maintainer guide §7.3](./maintainer-guide.md#73-benchmark-suites-and-qualification) |
| Warm startup | transport available p95 ≤ 500 ms with a reusable database | [Maintainer guide §7.3](./maintainer-guide.md#73-benchmark-suites-and-qualification) |
| Deep cursor | intended index required; temporary B-tree is a warning | `benchmark/baseline*.json` |

The `xl` profile is a deliberate stress corpus about four times the `large` file
count; its edit budget scales with corpus size rather than using the 15 s
production target.

## 3. Warm startup

The startup measurement spawns `dist/mcp.mjs`, completes the official MCP
`initialize` handshake against a reusable TypeScript database, and closes the
session. Sessions never overlap. Twenty iterations:

| Count | p50 | p95 | p99 | Max | Gate |
| ---: | ---: | ---: | ---: | ---: | --- |
| 20 | 231.5 ms | 239.6 ms | 255.5 ms | 255.5 ms | **pass** (p95 ≤ 500 ms) |

The reusable database was built from the pinned `microsoft/TypeScript`
checkout at `050880ce59e30b356b686bd3144efe24f875ebc8`, project file
`src/compiler/tsconfig.json`, 77 files and 17,028 symbols. Cold-start scanning
is not part of this value; the database was current before measurement.

## 4. Generated corpora

`typescript-generated` passed all five steps. Values are run 01 / run 02 for
`large`; `xl` has one run.

### Large: 2,704 files, 28,212 symbols, 35,713 occurrences

| Scenario | Wall | p95 | RSS peak | Database | CPU user+system |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold build (fresh process) | 3,706 / 3,699 ms | — | 1.05 / 1.03 GiB | 282.7 / 282.8 MiB | 4.7 / 4.8 s |
| Warm reuse | 220 / 220 ms | — | 0.80 / 0.80 GiB | 157.2 / 157.2 MiB | 0.28 / 0.28 s |
| Warm rebuild | 3,926 / 3,888 ms | — | 1.31 / 1.36 GiB | 402.7 / 403.3 MiB | 5.0 / 4.9 s |
| Edit-to-fresh | 31.8 / 32.0 s | 6,306 / 6,272 ms | 1.60 / 1.60 GiB | 526.7 / 525.2 MiB | 34.8 / 35.0 s |
| Deep cursor | 22.7 / 22.8 s | — | 0.83 / 0.83 GiB | 401.8 / 400.9 MiB | 24.4 / 24.4 s |

Query p95, both runs: `status` 0 ms, `find_symbol` 0 ms, `outline` 15 ms,
`find_references` 0 ms, `read_symbol` 1 ms.

### XL: 10,504 files, 122,512 symbols, 152,513 occurrences

| Scenario | Wall | p95 | RSS peak | Database | CPU user+system |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold build | 19,702 ms | — | 2.56 GiB | 1.17 GiB | 21.7 s |
| Warm reuse | 444 ms | — | 1.33 GiB | 671.1 MiB | 0.59 s |
| Warm rebuild | 20,555 ms | — | 3.82 GiB | 1.68 GiB | 23.0 s |
| Edit-to-fresh | 172.5 s | 34,644 ms | 3.31 GiB | 2.19 GiB | 182.7 s |
| Deep cursor | 112.9 s | — | 1.43 GiB | 1.67 GiB | 119.4 s |

Query p95: `status` 0 ms, `find_symbol` 0 ms, `outline` 90 ms,
`find_references` 0 ms, `read_symbol` 2 ms.

### Gate warnings

No gate failed. Recorded warnings:

- `plan.temp_btree`: six deep-cursor samples used a temporary B-tree in each run;
- `absolute.edit.p95`: 6,306 ms and 6,272 ms exceed the 5 s large warning
  threshold but stay below 15 s;
- `absolute.edit.p95`: 34,644 ms exceeds the 20 s xl warning threshold but stays
  below 40 s;
- `absolute.query.outline.p95`: 90 ms exceeds the 25 ms xl warning threshold but
  stays below 100 ms;
- `hygiene.artifact_consumption`: extraction artifacts are persisted but not
  consumed.

The relative gates were skipped because this is the first retained report. A
later run must pass this report as `--reference` to activate them.

## 5. Pinned public projects

The public suite ran on the pinned checkouts and failed overall because VS Code
could not be indexed. Compatibility and resource values below are directional
only: the suite is not a release gate and the committed external baseline
applies no reference report.

| Project | Files | Cold build | Warm reuse | Rebuild | Deep cursor | RSS peak (cold/rebuild) | Database (cold/rebuild) | `find_symbol` p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| TypeScript `050880ce` | 77 | 13.1 / 12.9 s | 178 / 177 ms | 14.1 / 14.5 s | 183 / 192 ms | 1.44 / 2.07 GiB, 1.76 / 2.38 GiB | 698.7 / 1,013.0 MiB | 10 ms |
| Material UI `28eadba9` | 1,063 | 9.9 / 9.7 s | 198 / 199 ms | 9.8 / 9.8 s | 204 / 216 ms | 1.83 / 2.17 GiB, 1.96 / 2.33 GiB | 220.0 / 319.1 MiB | 7 / 9 ms |

### VS Code failure

VS Code `072586267e68` did not produce a measurement. With the default worker
heap limit the build worker terminated with `JS heap out of memory` after about
34 s. Raising `NODE_OPTIONS=--max-old-space-size=8192` reached persistence and
failed the `symbol_name` constraint `length(name) > 0` for this authored
declaration in `src/vs/base/browser/dom.ts`:

```ts
type HHTMLElementTagNameMap = HTMLElementTagNameMap & { '': HTMLDivElement };
```

The empty-string member name is valid TypeScript but the persisted binding model
rejects it. This is a corpus/model limitation, not a performance regression.
The sanitized failure log is retained. VS Code is therefore excluded from this
baseline measurement.

Both causes are fixed in schema version 12: `symbol_name.name` no longer rejects
an empty terminal name, and the nightly pinned-public step declares an 8 GiB
heap. The pinned VS Code project now indexes end to end. Its local measurement on
a 64 GiB Apple M5 Max at `072586267e68` over 4,935 files was a 125 s cold build
with 5.8 GiB peak RSS, a 68 s rebuild with 7.4 GiB peak RSS, and a 3.4 GiB
database. No VS Code numbers are added to the table above because the table
remains the `0.6.0` Linux-hosted record and these values come from another
platform.

## 6. Retained evidence

The sanitized bundle is retained outside the checkout at:

```text
~/codeindex-evidence/baseline-20261024/retained
```

| Artifact | SHA-256 |
| --- | --- |
| `generated/summary.md` | `af84935b214d33a910f5a75577508eca0e6e350746a042442c25e347f203bb87` |
| `generated/manifest.json` | `41c60cca827df8032899c5570d3174de8be2a615fd36f07c9690cdd0db1539c0` |
| `public/summary.md` | `ce4176145b5a70075f3c0ee44f343eddf1cd4c37a4c97c2370b2a483c724fd34` |
| `public/manifest.json` | `f9a9d150faf280e12ce5ce2b59837a26506348fb31074343f323a622922639a3` |
| `startup/startup.json` | `9a5247fbcfcbf850bbf004ec45e613accfb8b17d3a0660e9e73585fb109d3916` |
| `checksums.sha256` | `42408680bc2d35bd04c9924ff9e86035fa296f951f11a75c9662e72044a14547` |
| `bundle.sha256` | `002e1b47da980c9fc4549e8668c8920396b3bab2bd1c72ecf58300baca478b54` |

`bundle.sha256` contains the digest of `checksums.sha256` shown above.

The bundle contains per-step JSON reports, evaluation sidecars, Markdown
summaries, both suite manifests, the startup record, the VS Code failure log,
and a README. Logs, generated workspaces, and databases other than
`startup.json` are not retained. Absolute paths are replaced with
`<workspace>`, `<projects>`, and `<home>`; no credentials or source text are
included.

## 7. Reproduction

Expected wall time on the reference profile: about 8 minutes for the generated
suite, 3 minutes for the public suite (VS Code fails after about 34 s), and
1 minute for the startup baseline including the reusable database build.

```bash
pnpm install --frozen-lockfile
pnpm build

evidence="$HOME/codeindex-evidence/baseline-20261024"
node dist/cli.mjs benchmark-suite \
  --suite benchmark/suites/typescript-generated.json \
  --output "$evidence/generated"

node dist/cli.mjs benchmark-suite \
  --suite benchmark/suites/typescript-public.json \
  --output "$evidence/public"

mkdir -p "$evidence/startup"
CODE_INDEX_ROOT="$HOME/.cache/codeindex-benchmark/projects/typescript" \
CODE_INDEX_PROJECT_FILE="$HOME/.cache/codeindex-benchmark/projects/typescript/src/compiler/tsconfig.json" \
CODE_INDEX_DATABASE="$evidence/startup/index.sqlite" \
CODE_INDEX_ANALYTICS=false \
CODE_INDEX_LOG_LEVEL=error \
node dist/cli.mjs rebuild

node evaluation/harness/src/cli.ts startup \
  --root "$HOME/.cache/codeindex-benchmark/projects/typescript" \
  --project-file src/compiler/tsconfig.json \
  --database "$evidence/startup/index.sqlite" \
  --iterations 20 \
  --output "$evidence/startup/startup.json"
```

The public checkouts under `~/.cache/codeindex-benchmark/projects` must already
be at the pinned revisions. `benchmark-prepare` provisions missing checkouts;
preparation happens outside the measured interval.

## 8. Limitations

- The baseline is one fixed corpus mix on one machine. It supports regression
  comparison, not population inference or agent-task cost claims.
- The first retained report has no reference, so relative gates are skipped; it
  becomes the reference for later runs.
- Public-project numbers are directional and the suite failed on VS Code.
- Deep-cursor wall time is not gated; the plan check requires the intended index
  and warns on a temporary B-tree.
- Hosted CI numbers are directional and do not replace reference-machine
  evidence.
- A change to the machine, runtime, corpus, or artifact identity requires a new
  baseline rather than comparing across identities.

[#47]: https://github.com/doberkofler/codeindex-mcp/issues/47
