# Enhancements: Dependency Removal

Status: proposed. No dependency change is approved by this document.

## 1. Purpose

Record every dependency that is a candidate for removal, the evidence behind the
decision, and the conditions that would reopen a closed decision. The goal is a
smaller install and toolchain surface without weakening an invariant in
`AGENTS.md`.

Decision rule:

1. Correctness and invariants first.
2. Maintenance reduction second.
3. Install size, dependency count, and lint time are tie-breakers, not goals.

A dependency is removed only when the remaining project-owned code is smaller,
simpler, or more correct than the library it replaces. "Unused" is proved with
`pnpm knip` and repository search, not assumed.

## 2. Baseline

Measured on 2026-10-19 against the current lockfile. Sizes are installed package
directories (`du -shL node_modules/<package>`); pnpm may hardlink part of this
into the store, so treat them as relative indicators.

### Runtime dependencies

| Dependency | Installed | Role | Disposition |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server` | 6.4 MB | MCP transport | Retain |
| `antlr4ng` | 11 MB | Runtime for the generated Oracle lexer | Retain |
| `chokidar` | 96 KB | Workspace freshness | Retain (adopted in `0fa0c04`) |
| `commander` | 232 KB | CLI parsing | Retain (adopted in `5663fea`) |
| `csv-parse` | 1.6 MB | Oracle CSV import | Retain (adopted in `2a9efda`) |
| `csv-stringify` | 1.0 MB | Oracle CSV export | Retain (adopted in `2a9efda`) |
| `debug` | 60 KB | Namespaced trace output | Evaluate (`DEP-2`) |
| `jsonc-parser` | 252 KB | OpenCode JSONC read and edit | Retain (`DEP-3`) |
| `typescript` | 24 MB | TypeScript extractor and compiler API | Retain; packaging decision (`DEP-4`) |
| `zod` | 8.1 MB | Runtime boundary validation | Retain |

### Development dependencies in scope

| Dependency | Installed | Role | Disposition |
| --- | --- | --- | --- |
| `@mui/icons-material` | 172 MB | 24 icons in 7 console files | Evaluate (`DEP-1`) |
| `@mui/material` | 16 MB | Console component library | Retain |
| `@emotion/react`, `@emotion/styled` | peer | Required by MUI | Retain; not directly imported |
| `@tanstack/react-query` | 2.6 MB | Console polling and invalidation | Retain (`DEP-5`) |
| `eslint-plugin-regexp` | 556 KB | Regexp rules for Oxlint | Retain (`DEP-7`) |
| `antlr-ng` | 5.0 MB | Regenerates the Oracle lexer | Retain |
| `vite`, `vitest`, `@vitest/coverage-v8` | 2.4–3.0 MB each | Build and tests | Retain |

`pnpm knip` reports no unused dependency. The only current findings are one
unused exported type and one duplicate export, both unrelated to dependencies.

## 3. Removal TODOs

### [ ] DEP-1 — Remove `@mui/icons-material`

- **Evidence:** 24 unique icons across 7 files, always imported per icon path
  (for example `@mui/icons-material/Refresh`). Installed package is ~172 MB.
- **Gain:** largest single reduction in developer and CI install footprint.
  No shipped bundle change: per-icon imports are already tree-shaken.
- **Cost:** maintain ~24 local SVG components plus the Apache-2.0 attribution
  already covered by the Material icon license. No icon API changes expected.
- **Plan:** create one console-local icon module, copy only the used paths,
  replace imports, then remove `@mui/icons-material`.
- **Acceptance:**
  - [ ] `rg "@mui/icons-material" src` returns nothing.
  - [ ] Console builds in all three color modes with visual parity.
  - [ ] `THIRD_PARTY_NOTICES.md` records the icon source and license.
  - [ ] Installed size and CI install time are measured before and after.
- **Verdict:** proceed only if the measured install-time reduction justifies
  owning the icon set. Otherwise keep the package and close this item.

### [ ] DEP-2 — Evaluate replacing `debug` with `node:util.debuglog`

- **Evidence:** 22 `debugFor` call sites; `src/core/logging/debug.ts` is the only
  module importing the package. `DEBUG` is documented as authoritative for MCP
  and ad-hoc runs.
- **Gain:** one runtime dependency and one `@types` package removed.
- **Cost:** `util.debuglog` reads `NODE_DEBUG`, not `DEBUG`; channel naming and
  output format differ. Reproducing the current contract needs a wrapper that
  reimplements the behavior the package already provides.
- **Acceptance:** either the documented `DEBUG=codeindex:*` contract is kept
  unchanged, or the change is rejected.
- **Verdict:** likely close as won't do. Revisit only if the tracing contract is
  redesigned for another reason.

### [ ] DEP-3 — Record why `jsonc-parser` stays

- **Evidence:** `src/transports/cli/mcpCommand.ts` uses `parse`, `modify`, and
  `applyEdits`. TypeScript's `parseConfigFileTextToJson` can read JSONC but
  cannot preserve formatting while editing.
- **Conclusion:** removal requires a project-owned JSONC editor, which is larger
  and less correct than the dependency.
- **Action:** close as won't do; keep the reason here so it is not re-proposed.

### [ ] DEP-4 — Decide whether `typescript` becomes an optional peer

- **Evidence:** 24 MB runtime dependency used by the default extractor.
- **Gain:** smaller default install for Oracle-only consumers.
- **Cost:** moves a hard failure from install time to first TypeScript scan;
  complicates the documented configuration and support matrix. `pnpm` and `npm`
  resolve optional peers differently.
- **Acceptance:** a documented Oracle-only installation path exists and is
  exercised in CI before this changes.
- **Verdict:** keep as a regular dependency until Oracle-only deployment is a
  stated requirement.

### [ ] DEP-5 — Record why `@tanstack/react-query` stays

- **Evidence:** two polling queries plus one mutation with cache invalidation in
  `src/ui/console/api.ts`, and a shared client in `main.tsx`.
- **Conclusion:** a custom hook would be comparable in size while reimplementing
  retry, deduplication, invalidation, and teardown behavior.
- **Action:** close as won't do. Reopen only if the console keeps a single query.

### [ ] DEP-6 — Keep the ANTLR toolchain

- **Evidence:** `antlr4ng` is the runtime for the generated Oracle lexer;
  `antlr-ng` regenerates it from the pinned grammar.
- **Conclusion:** both are required while the Oracle adapter uses an ANTLR
  lexer. Replacing them is an Oracle-adapter redesign, not a dependency cleanup.
- **Action:** no removal. Track any parser replacement separately.

### [ ] DEP-7 — Revisit `eslint-plugin-regexp` when Oxlint ships regexp rules

- **Evidence:** Oxlint 1.88 has no built-in `regexp` plugin; the package is loaded
  as a JS plugin in `oxc.config.ts`.
- **Cost:** JS plugins are slower than native rules.
- **Action:** keep today. Remove when an equivalent native plugin is available
  and enabled, then re-run lint timing.

### [ ] DEP-8 — Guard optional Oracle dependencies

- **Evidence:** `oracledb` is already an `optionalDependencies` entry and
  `@types/oracledb` a development dependency.
- **Action:** verify release packaging still installs without Oracle client
  libraries and that missing `oracledb` produces the documented error.

## 4. Rejected additions

Libraries considered and not adopted. These are not removals from
`package.json`; they are decisions that keep the dependency surface from growing.
Each entry is closed unless its reconsider trigger fires.

### [x] ADD-1 — Fastify / Hono for the console server

Target: `src/transports/console/server.ts`.

The server is loopback-only, has a small fixed route set, serves static assets,
and enforces explicit host/origin and path checks. A framework removes request
dispatch and response boilerplate but not the code that matters: binding
restrictions, traversal protection, error sanitization, and lifecycle.

Alternatives: keep native Node and split pure route matching, static-path
resolution, response helpers, and lifecycle only if testing becomes difficult.

Reconsider when the console gains a substantial JSON API, schema validation,
authentication or sessions, many plugins, or roughly 15–20 routes. Prefer Hono
only if runtime portability becomes a real requirement.

### [x] ADD-2 — MUI X Charts

The existing SVG chart is about 100 lines and presents a narrow, stable dataset.
A chart suite adds theming, accessibility, tooltip, layout, and bundle upgrade
surface for presentational code that is already easy to inspect.

Alternatives: keep the SVG component and extract scale/tick calculations into
tested pure functions; use `d3-scale` or `@visx/scale` only if that mathematics
becomes complex.

Reconsider when multiple chart types, zoom/brush selection, complex axes, or
shared interactive scales appear.

### [x] ADD-3 — Execa

Target: `src/core/benchmark/suiteCommand.ts`. The current wrapper enforces
bounded output, environment sanitization, progress forwarding, controlled
termination, and benchmark-specific diagnostics. Execa would not remove those
policies and could change signal propagation, buffering, truncation, and error
shape.

Alternatives: keep `node:child_process.spawn` behind one narrow bounded runner.
`execFile` buffers output, `spawnSync` blocks, and `zx` targets scripts rather
than security-sensitive core paths.

Reconsider when subprocess orchestration spreads across modules and needs shared
piping, cancellation, concurrency, or cross-platform command handling.

### [x] ADD-4 — `simple-statistics`

Percentile semantics are the contract, not the arithmetic. A general statistics
package adds a broad API and does not pin interpolation, empty-input, `NaN`, or
small-sample behavior; changing it silently can change benchmark results.

Alternatives: one internal statistics module with median, percentile, optional
mean, finite-input validation, documented interpolation, and fixed-vector tests.
`d3-array` fits only if D3 is adopted elsewhere; Math.js is far too broad.

Reconsider when several non-trivial operations appear: variance, regression,
distributions, or clustering.

### [x] ADD-5 — `p-queue`

The console queue encodes domain policy: which operations overlap, whether
requests coalesce, cancellation, progress exposure, and shutdown. `p-queue`
supplies concurrency, priorities, pause/resume, timeouts, and rate limiting but
cannot decide those semantics; a wrapper would remain.

Alternatives: a domain-named coordinator exposing `scheduleRefresh`,
`scheduleRebuild`, and `close`, backed by a promise tail or explicit state
machine. `p-limit` fits only pure concurrency limiting; Bottleneck only external
rate limiting.

Reconsider when scheduling becomes generic infrastructure rather than console
policy.

### [x] ADD-6 — Glob libraries

Node 26 provides `fs.glob`, `fs.globSync`, and `path.matchesGlob`. Adding `glob`,
`fast-glob`, or `micromatch` duplicates platform behavior and adds pattern-dialect
and upgrade concerns.

Native matching does not replace project path policy: workspace-relative POSIX
normalization, directory pruning, symlink rules, ignore precedence, extractor
inclusion, and generated-file exclusions remain project-owned.

Reconsider only for semantics native Node lacks, especially Gitignore
compatibility, complex brace/extglob matching, or measured traversal gains.

### [x] ADD-7 — ORM / query builder

The schema and transactions express core invariants: immutable published
generations, build leases, reader isolation, exclusion of `building` rows,
atomic publication, failed-build preservation, schema-version replacement, and
bounded queries. An ORM would translate those rules into model configuration,
transaction callbacks, escape hatches, and raw SQL rather than remove them.

Risks: per-row queries, hidden transaction boundaries, weak SQLite locking
expression, difficult publication logic, migration machinery contrary to the
rebuild-on-schema-change rule, and harder query-plan inspection.

Alternatives: keep explicit SQL behind focused repositories (generation, lease,
fact writer, read/query, schema boundary) with visible transaction boundaries.
If type-safety pain is demonstrated, prefer Kysely (typed SQL, raw escape hatch)
over Drizzle, Prisma, TypeORM, or Sequelize. SQL code generation is a third
option but adds build complexity.

Reconsider when row-shape mismatches recur, dynamic queries multiply, schema
types can be generated reliably, and benchmarks show no regression.

## 5. Verification checklist

For any removal that is approved:

- [ ] `pnpm knip` reports no new unused files, exports, or dependencies.
- [ ] `pnpm verify` passes.
- [ ] `pnpm build` passes and bundle sizes are compared before and after.
- [ ] Installed size and CI install time are measured with the same command.
- [ ] `THIRD_PARTY_NOTICES.md` is updated when a bundled dependency is removed.
- [ ] Affected documentation under `documentation/` is updated.
- [ ] Any change to configuration files or `package.json` scripts has explicit
      approval, per `AGENTS.md`.

## 6. Closed decisions

| ID | Decision | Reason |
| --- | --- | --- |
| DEP-3 | Keep `jsonc-parser` | `modify`/`applyEdits` preserve JSONC formatting |
| DEP-5 | Keep `@tanstack/react-query` | Polling, invalidation, and cache reuse |
| DEP-6 | Keep ANTLR toolchain | Required by the Oracle lexer |
| ADD-1 | No HTTP framework | Native loopback server is smaller and stricter |
| ADD-2 | No chart suite | One small SVG chart |
| ADD-3 | No Execa | Domain-specific bounded subprocess policy |
| ADD-4 | No statistics package | Small, semantics-sensitive surface |
| ADD-5 | No queue package | Queue behavior is application policy |
| ADD-6 | No glob package | Native Node APIs are sufficient |
| ADD-7 | No ORM | Storage invariants must stay explicit |
