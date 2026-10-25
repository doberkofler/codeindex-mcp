# Codebase Testing Strategy

Date: 2026-10-21

Status: accepted cleanup plan for implementation verification.

This document covers tests of the CodeIndex implementation. It does **not** establish
whether the MCP server is useful to an agent. Product usefulness, retrieval efficiency,
and model behavior are governed by the
[MCP evaluation strategy](./mcp-evaluation-strategy.md).

## 1. Purpose

Codebase tests should answer:

- does each module satisfy its interface;
- does the TypeScript adapter emit correct serializable facts;
- does storage preserve and publish those facts safely;
- does the MCP transport expose the core interface correctly;
- does the complete built process work with temporary data;
- can a failure be localized quickly.

## 2. Current state

The repository currently has 113 test files: 87 under `test/` and 26 under
`evaluation/harness/src/`. The file-level classification and ownership register is the
[Test inventory](./test-inventory.md). The complete suite takes about eleven seconds without
coverage and about fifteen seconds with coverage. Classification and ownership were the main
problems:

- module, adapter, storage, MCP, lifecycle, benchmark-harness, and Oracle tests share one
  directory, although the focused workflows in section 6 now select them by class;
- test names state the contract they protect; the former delivery-phase names are now
  `typescriptPublicationSurface.test.ts`, `oraclePublicationSurface.test.ts`, and
  `publicationDefaultsAndEnforcement.test.ts`;
- protocol-only MCP tests use a controlled fake index, and one vertical smoke keeps the real
  TypeScript wiring visible;
- fixture purpose, authority, and expected facts are catalogued in the
  [Test fixture catalogue](./test-fixtures.md);
- `qualify:typescript:fixture` supplies its own project and corpus paths, so the
  compiler differential gate no longer depends on CI-only environment variables.

## 3. Test classes

| Class | Interface under test | Data |
|---|---|---|
| Static verification | Compiler, lint, format, dead-code rules | Authored code |
| Module test | One module or pure algorithm | Inline values or handcrafted facts |
| Adapter contract | Workspace to serializable extractor facts | Small TypeScript fixtures |
| Core integration | Facts through finalization, SQLite, and query modules | Handcrafted facts and temporary SQLite |
| MCP protocol contract | Schemas, envelopes, errors, bounds, descriptions | Controlled fake index through `InMemoryTransport` |
| Deterministic system test | Built MCP process, worker, database, watcher, stdio | Temporary workspace |
| Semantic qualification | Adapter output versus independent compiler truth | Reference corpus |
| Performance test | Production artifact cost and regression | Generated and pinned corpora |

No LLM belongs in these tests.

## 4. Module and seam policy

The module interface is the primary test surface. Prefer one contract test through the
interface over many assertions against implementation helpers.

Test an internal helper directly only when it owns a complex algorithm whose failure
cannot be diagnosed economically through the outer interface. Core tests must use
language-neutral facts; they must not depend on the TypeScript compiler merely to create
input.

### TypeScript adapter seam

Test the adapter through:

```text
configured workspace -> scan -> build -> serializable extracted facts
```

Cover:

- project configuration, `extends`, include/exclude, imported files, and `allowJs`;
- declaration kinds, extents, ownership, aliases, merging, and re-exports;
- reference roles, usage, owners, and project contexts;
- static, type-only, dynamic-literal, `require`, authored, and package dependencies;
- publication roots, surface projection, exposure, reachability, and ceilings;
- deterministic identity and ordering;
- diagnostics, unsupported constructs, and failure behavior.

### MCP seam

Protocol-contract tests use the official client and `InMemoryTransport`, but a controlled
fake index. They cover:

- exact tool inventory and schemas;
- argument validation;
- success and error envelopes;
- stable error codes;
- compact and detailed projections;
- pagination and byte bounds;
- server instructions and tool descriptions;
- analytics recording.

Retain one vertical protocol smoke test with a real TypeScript index. Do not repeat every
adapter and query assertion through MCP.

The protocol contracts live in `test/mcp.test.ts`, `test/mcpGuidance.test.ts`,
`test/mcpStatus.test.ts`, and `test/mcpServerAnalytics.test.ts`; all use
`test/helpers/fakeIndex.ts`, which returns fixed generation, symbol, reference, dependency,
status, and source facts. Because the fake returns those facts directly, these files own only
transport-facing behavior: tool inventory and input schemas, argument rejection, success and
error envelopes, stable error codes, compact and detailed projection, paging and byte bounds,
server instructions and descriptions, guidance attachment, and analytics recording.

`test/mcpSmoke.test.ts` is the single real-index MCP test. It calls all seven tools over one
temporary TypeScript fixture to prove adapter, query, transport, and byte-bound wiring without
re-asserting extractor or query semantics. Those semantics stay with the adapter, core
integration, and semantic-qualification classes. `test/referenceGrouping.test.ts` calls
`CodeIndex` directly for the same reason.

### Deterministic system seam

Start the built `dist/mcp.mjs` over stdio with the official client and a temporary
workspace. Prove initial publication, all tools, stdout isolation, source edits, stale
refusal, watcher rebuild, add/delete/rename, failed-build isolation, restart reuse, and
clean shutdown. A second built process on the same database proves single-owner contention,
reader isolation, dead-owner heartbeat failure, and expired-lease takeover without a half
publication.

## 5. Test data

Use these classes:

| Data | Purpose | Expected result |
|---|---|---|
| Micro fixture | One syntax or failure class | Reviewed exact facts |
| Vertical fixture | Small complete build/query path | Reviewed stable behavior |
| Reference corpus | Differential reference accuracy | Language-service gate passes |
| Generated corpus | Cardinality and performance | Versioned counts and budgets |
| Pinned public corpus | Compatibility and scale | Invariants and qualification gates |

Every fixture needs a catalogue entry containing its claim, constructs, authoritative
expected result, consuming tests, mutation policy, known limitations, and update process.
The catalogue is [Test fixture catalogue](./test-fixtures.md).

Prefer semantic assertions and independent compiler comparisons. Avoid large snapshots
generated by the implementation under test. Every production bug receives the smallest
possible regression fixture.

## 6. Target workflows

The workflows are implemented as package scripts. Class membership is declared in
`vitest.config.ts`, and the complete gate remains `pnpm verify`. Each focused workflow
selects one class, except `test:fast`, which composes the fast classes and the fake-index
MCP tests. `test:system` builds `dist` before it runs the deterministic system class.

`pnpm verify:pr` is the single pull-request entry point. It builds `dist` once, runs the
complete verification pass once, and then runs the fixture qualification against that same
build. CI invokes only `pnpm verify:pr`; the former separate CI build and qualification
steps are gone. Focused workflows are developer tools and are not invoked by the PR gate,
so no test file runs twice in one pull request. `qualify:typescript:fixture` still builds for
standalone use; `qualify:typescript:fixture:built` is the build-free entry point used after
the PR gate has built `dist`.

The pull-request path previously duplicated work in three places: qualification was defined
twice (the CI command and the package script), the package qualification rebuilt `dist` after
CI had built it, and the CI and package workflows each claimed the complete test pass. The
collapsed path is one `pnpm build`, one `pnpm verify`, and one
`qualify:typescript:fixture:built`.

`scripts/run-test-workflow.mjs` enforces every budget and prints the measured wall-clock
time. A budget breach fails the command. `vitest.config.ts` also rejects a fast-class test
that is classified with the system or qualification tests, so heavy checks move class
instead of stretching the fast path. The Oracle tier is the exception to static membership:
`oracle*.test.ts` modules are discovered from disk, so a new Oracle module joins `test:oracle`
without a config edit and cannot be silently omitted. The budgets are reference-machine measurements; a
runner that is not the reference machine sets `CODE_INDEX_TEST_BUDGET_MS` to declare its
own wall-clock budget. The hosted pull-request runner uses 5 min because the same suite
takes 217 s there against 37.3 s on the reference machine.

| Workflow | Script | Contents | Budget | Measured |
|---|---|---|---:|---:|
| `test:fast` | `pnpm test:fast` | Module, adapter micro-fixture, core, and fake-index MCP tests; no coverage | <=10 s | 6.7 s, exit 0 |
| `test:typescript` | `pnpm test:typescript` | All TypeScript adapter and reference-corpus tests | <=15 s | 2.9 s, exit 0 |
| `test:mcp` | `pnpm test:mcp` | MCP protocol contracts and one vertical smoke | <=15 s | 0.8 s, exit 0 |
| `test:system` | `pnpm test:system` | Built-process deterministic system tests | <=60 s | 19.0 s, exit 0 |
| `test:oracle` | `pnpm test:oracle` | Every `oracle*.test.ts` module discovered from disk plus the pinned generic Oracle contracts | <=60 s | 5.0 s, exit 0 |
| `test:oracle:bundle` | `pnpm test:oracle:bundle` | Controlled-bundle preflight and offline replay | <=120 s | 2.2 s, exit 0 |
| `test:oracle:live` | `pnpm test:oracle:live` | Read-only catalogue inventory and DDL-refusal preflight; skipped without `CODE_INDEX_ORACLE_LIVE=1` | <=180 s | 5.6 s, exit 0 |
| `qualify:typescript:fixture` | `pnpm qualify:typescript:fixture` | Self-contained compiler differential gate | <=60 s | 1.6 s, exit 0 |
| `verify:pr` | `pnpm verify:pr` | Static checks, coverage, all deterministic tests, build, qualification | <=2 min | 37.3 s, exit 0 |

Measured on 2026-10-24 on the reference machine (Apple M5 Max, macOS 27.0.1,
Node 26.10.0, pnpm 12.15.0). `qualify:typescript:fixture` also passes with
`env -i PATH HOME`. The 60 s system budget includes its build. The `verify:pr`
measurement includes its single build and the fixture qualification.

Nightly workflows run generated and pinned-public-corpus performance and compatibility
checks. Stable-machine or release workflows run retained-reference comparisons, soak,
and multi-process lifecycle tests.

### 6.1 Scheduled and release workflows

`nightly.yml` runs on the declared reference runner every day and on manual dispatch. It
runs the generated benchmark, the pinned public suite, and the TypeScript compiler
differential. The generated job reuses the newest successful run of the same profile as
its reference when one exists; the public suite uses its committed baseline and retained
first run.

`stable.yml` runs on manual dispatch or from `release.yml` before the release is published.
It runs `pnpm verify:release`, two retained-reference benchmark runs, the operational soak,
and the deterministic system class. `release.yml` publishes only after that job passes.

Neither workflow is invoked by `pnpm verify:pr` or `ci.yml`. Their jobs declare budgets
through `timeout-minutes`, upload only curated reports for a bounded retention period, and
state the failing class from section 7. The operational contract and artifact-privacy
rules are recorded in [Verification workflows](../.github/workflows/README.md).

## 7. Failure meaning

| Failure | Primary interpretation |
|---|---|
| Module test | Local algorithm or interface defect |
| Adapter contract | TypeScript extraction defect |
| Core integration | Finalization, storage, or query defect |
| MCP protocol | Transport/schema/projection defect |
| Deterministic system | Wiring, process, worker, watcher, or lifecycle defect |
| Semantic qualification | Adapter divergence from compiler truth |
| Performance gate | Runtime or resource regression |

One behavior should have one primary test class. Higher layers retain only enough overlap
to prove wiring.

## 8. Cleanup sequence

1. Inventory every existing test by class, interface, data, and expected claim.
2. Catalogue the existing TypeScript fixtures before adding more.
3. Add self-contained focused commands.
4. [x] Rename historical phase tests by enduring behavior.
5. [x] Split MCP protocol assertions from real-index vertical tests.
6. [x] Add a controlled fake index for protocol tests.
7. [x] Add one built-process deterministic system test.
8. [x] Remove duplicate qualification execution while retaining one PR gate.
9. Fill only contract-matrix gaps; do not increase test count without a named risk.
10. [x] Keep the fast workflow below its budget as the suite grows.

Changes to `package.json`, Vitest configuration, or other build/lint configuration require
explicit approval under repository rules.
