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
clean shutdown.

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

| Workflow | Script | Contents | Budget | Measured |
|---|---|---|---:|---:|
| `test:fast` | `pnpm test:fast` | Module, adapter micro-fixture, core, and fake-index MCP tests; no coverage | <=10 s | 6.7 s, exit 0 |
| `test:typescript` | `pnpm test:typescript` | All TypeScript adapter and reference-corpus tests | <=15 s | 4.4 s, exit 0 |
| `test:mcp` | `pnpm test:mcp` | MCP protocol contracts and one vertical smoke | <=15 s | 0.6 s, exit 0 |
| `test:system` | `pnpm test:system` | Built-process deterministic system tests | <=60 s | 12.6 s, exit 0 |
| `qualify:typescript:fixture` | `pnpm qualify:typescript:fixture` | Self-contained compiler differential gate | <=60 s | 1.5 s, exit 0 |
| `verify:pr` | `pnpm verify:pr` | Static checks, coverage, all deterministic tests, build, qualification | <=2 min | 32.5 s, exit 0 |

Measured on 2026-10-22 on the reference machine (Apple M5 Max, macOS 27.0.1,
Node 26.10.0, pnpm 12.14.0). `qualify:typescript:fixture` also passes with
`env -i PATH HOME` and exits 0 in 1.5 s. The 60 s system budget includes its build.

Nightly workflows run generated and pinned-public-corpus performance and compatibility
checks. Stable-machine or release workflows run retained-reference comparisons, soak,
and multi-process lifecycle tests.

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
8. Remove duplicate qualification execution while retaining one PR gate.
9. Fill only contract-matrix gaps; do not increase test count without a named risk.
10. Keep the fast workflow below its budget as the suite grows.

Changes to `package.json`, Vitest configuration, or other build/lint configuration require
explicit approval under repository rules.
