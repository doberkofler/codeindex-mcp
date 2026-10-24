# Maintainer Guide

## 1. Purpose

This document preserves operational and quality contracts needed to evolve the
index safely. Shipped behavior remains authoritative in code and tests; planned
adapter behavior is identified in the roadmap and adapter designs.

## 2. Startup contract

1. Validate configuration before opening transport or storage.
2. Open the derived database and enforce its schema version.
3. Read the published generation.
4. Open MCP transport without waiting for a rebuild.
5. Start watchers for adapter-declared source and configuration inputs.
6. Reconcile deterministic workspace state in a worker.
7. Reuse a matching generation or build and atomically publish a replacement.

With no generation, queries return `index_not_ready`. With an older published
generation, queries may continue during refresh but report non-current freshness.

## 3. Refresh contract

The coordinator permits one active build and one coalesced follow-up:

- an event marks state dirty;
- burst events are debounced;
- events during a build set one follow-up flag;
- successful publication returns to current or schedules the follow-up;
- failure retains the published generation and reports stale;
- periodic reconciliation repairs missed watcher events;
- shutdown rejects scheduling, closes watcher/timers, stops the worker, then closes
  SQLite.

Filesystem events are hints. Adapter scanning is authoritative. Exact debounce and
reconciliation intervals are measured configuration, not architectural constants.

## 4. Publication and concurrency

- lease acquisition/renewal is transactional;
- only the lease owner creates or publishes a generation;
- ownership uses a random owner token, never process ID alone;
- the owner renews the lease while its worker builds;
- takeover occurs only after expiry;
- non-owners remain readers and observe external publication;
- every query resolves one published token at start and keeps it for the call;
- failed private generations never replace the published generation.

Schema changes bump `SCHEMA_VERSION`. Move one incompatible database aside as a
`.schema-<version>.bak` file and rebuild. Never add in-place migrations to derived
index data.

Finalization and persisted validation run while the generation is `building` and
before publication. Production builds run the structural invariants in `enforce`
mode; a violation or a per-root ceiling overrun fails the candidate and retains the
previous published generation. Qualification-only overrides run in `report` mode,
where an overrun marks the report incomplete instead of truncating facts. Changing an
input that can alter emitted facts changes `config_hash`; changing a compiled ceiling
or extractor semantic requires an adapter-version bump, which is part of the project
configuration identity.

## 5. Adapter acceptance

Every adapter must provide:

- deterministic project/configuration identity;
- exact included files and explicit exclusions;
- raw-content and context hashes;
- serializable facts without compiler/parser/database objects;
- bounded diagnostics and explicit coverage limitations;
- fixtures for supported and unsupported syntax;
- a validation authority: language service, parser corpus, dictionary, or reviewed
  mapping sample;
- freshness inputs and watchable configuration files;
- privacy classification for every persisted field.

Parser success is not semantic validity. Generated output must pass adapter-specific
precision, completeness, and consistency checks before publication.

## 6. Verification matrix

Unit tests cover:

- refresh transitions, debounce, follow-up, failure, and shutdown;
- path filtering and configuration invalidation;
- freshness mapping and dirty-source rejection;
- lease acquisition, renewal, expiry, and ownership;
- schema replacement and content deduplication;
- external publication observation;
- pagination/cursor binding and byte bounds;
- analytics privacy, rotation, retention, and opt-out;
- adapter extraction and unresolved/ambiguous cases;
- critical query plans.

Integration tests use temporary fixture workspaces, databases, and—when needed—a
disposable development Oracle schema. They never use a real checkout or production
database. Cover initial build, reuse, add/change/delete/rename, configuration
change, blocked build, failure recovery, two-process contention, lease-owner death,
responsive MCP transport, and every production bundle.

Oracle integration additionally proves read-only operation, dictionary privilege
modes, overload preservation, source/live mapping, and PL/Scope unavailable paths.
ORDS integration uses sanitized fixtures or disposable metadata and proves route
ambiguity and authorization-fact retention.

## 7. Performance verification

Measure these layers independently:

1. storage statement execution;
2. core method execution;
3. MCP serialization and transport;
4. client wrapping such as Code Mode;
5. complete agent task.

Measure warm/cold queries, deep cursors, bounded reads, cold build, no-change
refresh, one-file edit, configuration invalidation, event bursts, startup,
event-to-publication, memory, CPU, database growth, contention, takeover, and an
edit/restart soak.

Every hot query must have an intended bounded `EXPLAIN QUERY PLAN`. Replace offset
pagination when latency grows with cursor depth. Apply SQLite tuning only after a
benchmark proves benefit without weakening publication safety.

### 7.1 Model-free benchmark command

```bash
# Generated corpus; cold, no-change, forced rebuild, deep cursor, and queries
codeindex-cli benchmark --profile small --scenarios cold,warm,rebuild,deep

# Add one-file edit-to-fresh rounds (generated corpora only; source is mutated)
codeindex-cli benchmark --profile medium --scenarios cold,edit --edit-rounds 5

# External checkout; only non-mutating scenarios. Database stays temporary.
codeindex-cli benchmark --root /path/to/project --scenarios cold,warm,rebuild,deep

# Enforce gates, write an evaluation sidecar, and publish a Markdown summary.
codeindex-cli benchmark --profile large --scenarios cold,warm,rebuild,edit,deep \
  --baseline benchmark/baseline.json \
  --evaluation benchmark/results/nightly.evaluation.json \
  --summary benchmark/results/nightly.md

# Add --reference <retained-report.json> when a retained reference exists.
```

The report schema is version 2 and is written to `benchmark/results/` by default.
Scenarios share one process. For process-cold RSS and allocator state, invoke one
scenario per process, for example `--scenarios cold`.
Each scenario records wall time, CPU user/system time, RSS start/peak/end,
database plus WAL/SHM bytes, content and extraction-artifact counts, build
stages, and generation/content reuse. Edit-to-fresh records every write-to-fresh
latency plus p50/p95/p99/max. Deep cursor samples record the exact production
statement's plan, whether the intended index was used, and whether SQLite built a
temporary B-tree.

### 7.2 Gates, baselines, and reporting

`benchmark/baseline.json` is versioned independently (`schemaVersion: 1`). It
declares the accepted report schema version, workspace compatibility, required
scenarios, thresholds, and an optional reference. Each generated profile has its
own baseline: `baseline.json` for `large` and `baseline-<profile>.json` for
`small`, `medium`, and `xl`. `--reference` accepts a previous
benchmark report and overrides the embedded reference, so an accepted nightly
report can be compared without editing the baseline. Only the report schema
version, machine, workspace identity, scenario, and query measurements are
retained. Relative gates activate only when a reference is present. The reference must also match the current report schema,
workspace kind, profile, and generated corpus counts; an obsolete or unrelated
reference fails compatibility and its relative gates are skipped.

Every gate has `status: pass | warning | failure | skipped`. The CLI writes
`<report>.evaluation.json` by default when `--baseline` is supplied. Only
`failure` produces exit code 1; warnings remain successful. Nightly gates should
therefore fail on major regressions, incompatible corpora, or invalid deep-cursor
plans, not on advisory debt.

The committed baseline applies absolute gates for edit-to-fresh p95 and query p95
(warning above 25 ms, failure above 100 ms). Edit-to-fresh budgets scale with the
generated corpus: `small`, `medium`, and `large` warn above 5 s and fail above
15 s, while `xl` — roughly four times the `large` file count — warns above 20 s
and fails above 40 s. A budget that ignores corpus size fails on corpus growth
rather than on a regression. Deep-cursor samples fail when an intended index is
missing and warn when SQLite uses a temporary B-tree. Relative build, edit,
query, RSS, CPU, and storage
gates use the configured ratios and slack values. Generated corpus file and
symbol counts are checked against deterministic profile expectations, so they
must stay within the compatibility tolerance even when no reference exists. An
external workspace still needs a reference for its count drift to be meaningful.
Reference-machine mismatches warn. Relative gate failures are downgraded to
warnings only when the reference platform or architecture differs; a CPU-model
difference alone remains enforceable on the same platform. Absolute gates and
invalid plans still fail on any machine.

`--summary <path>` writes GitHub-flavoured Markdown derived from the same JSON
report and evaluation. The report and evaluation JSON remain authoritative. The
scheduled workflow writes both artifacts and appends the summary to
`$GITHUB_STEP_SUMMARY`.

Generated workspaces and temporary databases are deleted after the run. Pass
`--keep-workspace` to retain both paths for inspection; an explicit `--workspace`
already persists the corpus without that flag.

A generated corpus carries a `.codeindex-benchmark.json` marker recording its
profile and expected counts. `--workspace` reuses a directory only when that
marker is present and matches `--profile`; a directory that merely contains a
`tsconfig.json` is rejected so measurements cannot be attributed to an unrelated
project.

Artifact reuse is currently measured as zero because extraction artifacts are
persisted but never consumed. This produces a warning, not a failure; implement
artifact consumption only when a measured gate requires it.

Generated profiles are deterministic and disposable: `small`, `medium`, `large`,
and `xl`. Real-project runs use a pinned public checkout, recorded revision,
project file, dependency-lock hash, and Node identity. Edit-to-fresh refuses an
external root so a benchmark never modifies a user checkout.

Run small profiles in ordinary development. Run `large` or `xl` and pinned public
projects in the nightly job with broad order-of-magnitude bounds. Hard latency and
resource gates use a stable reference machine; hosted CI numbers are directional.

Nightly public-project set:

| Project | Selected project file | Coverage |
| --- | --- | --- |
| `microsoft/TypeScript` | compiler project discovered during qualification | compiler-heavy, dense references |
| `microsoft/vscode` | `src/tsconfig.json` | large application graph |
| `mui/material-ui` | `packages/mui-material/tsconfig.json` | TSX, re-exports, package boundaries |

Each run records the repository URL, exact revision, project file, dependency-lock
hash, and Node identity. Checkouts and dependency setup happen outside the measured
scenario. Do not commit checkouts, installed dependencies, or derived databases.

The scheduled [nightly workflow](../.github/workflows/nightly.yml) runs the generated corpus
and the pinned public suite on the reference runner, selects the baseline for the dispatched
generated profile, and downloads the newest successful run of the same profile as its
reference, so a manual run of another profile never becomes the nightly reference. It also
runs the compiler differential. It enforces the committed gates, uploads bounded reports,
and publishes the Markdown summary. Relative build, RSS, CPU, storage, and query gates are
therefore active on scheduled runs; reference-machine gates remain authoritative when a
retained report is supplied explicitly.

The [stable workflow](../.github/workflows/stable.yml) runs retained-reference comparisons,
the operational soak, and the deterministic system class on the declared reference runner.
`release.yml` calls it before publishing a tag. Triggers, budgets, artifact retention, and
failure classes are recorded beside the workflows in
[Verification workflows](../.github/workflows/README.md).

### 7.3 Benchmark suites and qualification

A benchmark run is orchestrated from a declarative suite rather than a sequence
of shell commands. Two TypeScript suites are committed:

- `benchmark/suites/typescript-generated.json` runs generated `large` twice and
  `xl` once, and measures `large` cold builds in a fresh process.
- `benchmark/suites/typescript-public.json` pins TypeScript, VS Code, and
  Material UI revisions and runs non-mutating scenarios twice per project.

Semantic accuracy is a separate qualification operation, not a benchmark step:

- `pnpm qualify:typescript:fixture` runs the TypeScript language-service gate against
  `test/fixtures/reference-corpus/` with the project and corpus paths supplied by the
  script.
- `pnpm qualify:oracle` compares the indexed Oracle workspace with exported
  PL/Scope and dependency CSV files. It performs no Oracle connection and no DDL.

```bash
pnpm benchmark:typescript:generated -- --output ~/codeindex-evidence/typescript-generated
pnpm benchmark:typescript:public:prepare
pnpm benchmark:typescript:public -- --output ~/codeindex-evidence/typescript-public
pnpm qualify:typescript:fixture
```

Each step runs the built CLI in a fresh process. Generated profiles use a fresh
corpus per run because edit-to-fresh mutates source. Public projects must already
be checked out at the pinned revision; `benchmark-prepare` clones and installs
them outside the measured interval and never mutates them during a run. Dependency
installation disables project lifecycle scripts: benchmarks index third-party
source without building or executing it, and project Node version pins may differ
from the CodeIndex runtime.

The evidence directory contains:

- `manifest.json` with suite hash, CodeIndex commit, CLI SHA-256, Node/SQLite and
  machine identity, baseline hashes, public-project revisions, and per-step
  results;
- per-run reports, evaluation sidecars, and Markdown summaries;
- the reference-verification report;
- `summary.md` and `checksums.sha256`.

The evidence directory must be outside the repository. `--resume` reuses passed
steps only when the suite content, CodeIndex commit, working-tree status, CLI
bundle, and machine identity are unchanged. `--allow-dirty` is required for an
uncommitted checkout. Generated corpora and databases are removed after a
successful run unless `--keep-workspace` is supplied.

The nightly workflow keeps its generated-`large` regression job on the reference runner.
Authoritative reference-machine evidence is produced by the suite on stable hardware and
retained explicitly; hosted runner numbers remain directional. The stable and nightly
workflows declare the reference runner profile and retain only sanitized, bounded evidence.

Reference-machine targets:

| Dimension | Gate |
| --- | --- |
| Stale source | Zero stale source returned |
| Reference quality | ≥99.5% recall and 100% precision on ≥200 stratified symbols |
| One-file freshness | p95 ≤15 s |
| Warm SQLite query | p95 ≤25 ms with intended plan |
| Bounded source read | p95 ≤50 ms |
| Local MCP call | p95 ≤100 ms excluding model scheduling |
| Cached status | p95 ≤25 ms without workspace scan |
| Warm startup | transport available ≤500 ms with reusable database |
| Build queue | one active build and one coalesced follow-up |
| Idle CPU | average <1% after reconciliation |
| Reliability | four-hour edit/restart soak without manual repair |

Hardware-sensitive gates may be recalibrated only with the prior baseline,
replacement value, machine identity, and reason recorded. CI may use broader
regression bounds but must detect order-of-magnitude regressions. The current
retained reference-machine record, its bundle digest, and its reproduction
commands are in [Reference-workstation baseline](./reference-baseline.md).

### 7.4 Operational soak and recovery

`soak` is the model-free E3 evaluation. It generates a deterministic TypeScript
corpus, drives the real watcher and build worker through a fixed edit script,
and records edit-to-fresh latency, events during active builds, restart
generation reuse, stale-source refusal, CPU, RSS, storage, and retention bounds.
It then injects one source-read failure and one failure from an edit during a
build, and requires both to recover without a manual command.

```bash
codeindex-cli soak --profile small --rounds 8 --burst-edits 3 \
  --failures 1 --restarts 1 --output benchmark/results/soak.json
```

Every event appends deterministic source text and verifies that the file hash
changed. The report records the plan hash and edit-script hash, so the same
command reproduces the same content sequence. Build failures carry a closed
`cause` (`source-read`, `source-changed`, `configuration`, `compiler`,
`extraction`, `persistence`, `verification`, `publication`, `lease`, `worker`,
or `unknown`); the same value is written to the `build_failed` analytics event
and summarized by `analytics summary`.

The declared retention policy is one published plus one superseded generation.
Every observation must stay within two generations, twice the indexed file count
for content versions, and two extraction artifacts per content version.
Database bytes are reported but not gated by an arbitrary threshold; row counts
prove the policy bound. A report that fails any gate exits non-zero. Generated
workspaces and databases are removed after the report is written unless
`--keep-workspace` is supplied. Operational results are never pooled with agent
task latency.

## 8. Analytics and privacy

Analytics are local, versioned, bounded, and optional. Record tool, duration,
bytes, counts, truncation, freshness, stable error code, build stages, watcher
coalescing, lease events, storage size, and bounded resource samples.

Never record source, snippets, prompts, model responses, queries, symbol names,
credentials, request values, SQL values, headers, cookies, IP addresses, or
absolute paths. Rotate by size, count, and age. Analytics cannot infer tool
adoption because MCP cannot observe fallback tools; use an explicitly approved
client event export for that denominator.

## 9. Release discipline

- run `pnpm verify:pr`; it builds `dist` once and gates the pull-request path;
- let the release workflow call stable verification before publishing; a failed retained
  reference, soak, or deterministic system check blocks the tag;
- keep stdout reserved for MCP framing;
- inspect bundle contents for accidental evaluation/private code;
- update architecture, adapter limitations, roadmap status, and changelog;
- pin evaluation to the production MCP artifact;
- smoke-test connection, one navigation chain, edit freshness, and reconnect after
  upgrade;
- never weaken TypeScript, lint, format, Knip, or test checks to ship.

### 9.1 Post-release monitoring

Watch the first week after a tag through the release issue and consumer reports.
No production telemetry is collected; analytics remain local and opt-out. Inspect:

- the startup banner reports the released program version;
- MCP initialization succeeds and request 1 presents the declared tool surface;
- `codeindex_index_status` reports fresh generation state and scope;
- `read_symbol` returns `stale_file` rather than source after an edit;
- client shutdown leaves no detached CodeIndex MCP process;
- reported wrong answers, false absences, crashes, or data loss.

A reproducible stale-source result, false absence, missing request-1 tool, orphan
process, or crash is a patch-or-rollback trigger. Record the failing version,
configuration, client, and reproduction in the release issue before changing code.

### 9.2 Artifact caveat

A version bump changes the program version embedded in `dist` and therefore the
artifact digest. When a release is built from an already certified source revision,
state in the release notes whether the published artifact is byte-identical to the
certified artifact or differs only in version metadata. Cost evidence remains scoped
to the artifact that was actually measured; a version-only delta does not create a
new exact-artifact cost claim.

## 10. Rollback

Rollback is configuration-only: disconnect or remove the MCP registration and use
normal repository tools. The index is derived data. Cleanup may remove bounded
cache and analytics locations but never source, build artifacts, or retained
evaluation evidence unless separately requested.

Repin to the previous known-good tag; do not move or rewrite a published tag. If no
previous tag is compatible, remove the registration until a patch is released.
Preserve the failing version and evidence so the defect can be reproduced.
