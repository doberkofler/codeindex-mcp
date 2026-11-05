# TypeScript 7.1 API migration

Status: migration branch `feat/typescript-7-1-api`, not merged. This record
supports the acceptance evidence for issue #136.

## Pinned compiler

`@codeindex/adapter-typescript` depends on the exact beta version
`typescript@7.1.0-beta`. No dist-tag is used. Compiler provenance is reported from
that package's own version export, so `index_status` and the persisted scan rows
report `7.1.0-beta`.

## API surfaces

The adapter no longer imports the legacy root compiler API.

| Concern | TypeScript 7 surface |
| --- | --- |
| Configuration, programs, snapshots | `typescript/sync` (`API`, `Program`, `Project`, `Snapshot`) |
| Checker queries | `typescript/sync` (`Checker`, `Symbol`, `Type`, `Signature`) |
| Syntax trees and types | `typescript/ast` |
| Node and type guards | `typescript/ast/is` |
| Rooted path values | `typescript/path` |
| Host filesystem and server fallbacks | `typescript/fs` (`serverFS`) |

`src/compiler.ts` is the single adapter-internal compatibility module. It
re-exports the supported surfaces and provides the small AST helpers the 7.x API
no longer publishes: `forEachChild`, `getModifiers`, `canHaveModifiers`,
`findAncestor`, `isDeclarationStatement`, diagnostic text flattening, and
symbol/declaration resolution.

## Input snapshot and resolution

The capture recorder is exposed to the compiler process as host filesystem
callbacks. Configuration parsing, module resolution, and program construction all
read the captured bytes, so extraction still observes one immutable version.

- Configuration: `API.readConfigFile` followed by
  `API.parseJsonConfigFileContent` through the recorder filesystem.
- Program construction: `API.createSnapshot` opens every configured project and
  builds its program. Each configured project owns its current directory, so
  options such as `types` resolve from the project file rather than from the
  workspace root. Building the programs is the authoritative resolution pass:
  the compiler parses every reachable file and probes every candidate path
  through the recorder, so the manifest describes exactly what the facts depend
  on.
- Program retention: the snapshot keeps the configured project programs and
  `loadTypeScriptProject` reuses them. Extraction therefore queries one program
  per project instead of building a second one.
- `API.createModuleResolver` remains available for dependency-edge and
  reference-construct queries.
- `/// <reference path>` resolution is performed by program construction.
- `/// <reference types>` directives are read by program construction and are
  therefore captured.

The earlier implementation walked reachability by hand with
`API.createSourceFile` plus one `API.resolveModuleName` per import. That
duplicated work the program performs anyway and issued thousands of synchronous
requests. It was replaced by program construction: 263 ms versus 1,427 ms for
the same snapshot on this repository, with a larger captured input set.

### Deterministic manifest

The compiler's filesystem callback traffic is not deterministic: across
otherwise identical runs it probes a varying set of directories. Hashing that
raw traffic made `inputHash` unstable and could fail the scan-to-build
consistency check.

After capture, the recorder seals its probes: every input is probed for
existence and its parent directory listing is probed. A newly created sibling
still invalidates the manifest, while unchanged inputs always produce the same
hash. Values remain deterministic because directory listings are sorted.

### Deterministic symbol names

TypeScript 7 escapes `#private` member names as `__#<nodeId>@#name`. The node id
is compiler-internal and changes between program instances, so persisting it
made symbol ids and names unstable and hid the authored name from search. Names
are now normalised to the authored `#name` before they reach symbol identity,
projection, or the persisted record. `isPrivateProperty` uses the same
normalisation, so private members no longer leak into published surfaces.

## Disposal

Every disposable compiler resource is released on success and failure paths.

- The snapshot owns one compiler API process and one configured project per
  project. `snapshot.dispose()` releases the compiler snapshot and the API
  process.
- `loadTypeScriptProject` returns a `dispose` handle that releases the module
  resolver, releases the program only when it created it, and closes the API
  process only when it created it.
- `buildTypeScriptFacts`, `scanProject`, the reference union, the publication
  prototypes, and the reachability truth comparison dispose in `finally`.
- `read_symbol`-style consumers never retain compiler objects; only serializable
  facts leave the adapter.

## Fact parity

Separate databases and separate worktrees were used. The TypeScript 6 baseline is
`main` at `c2c2ff3`.

Fixtures: `reference-corpus`, `dependency-cases`, `simple-project`,
`publication-project`, `typescript-require`, `javascript-project`.

Result: every fact collection was byte-identical — files, symbols, occurrences,
bindings, binding contexts, binding sites, surface origins, dependency edges and
bindings, and adapter statistics. Only these expected fields differ:

- `configHash` and `inputHash`, because the compiler version and recorded probe
  kinds are part of the digest;
- diagnostic text where the 7.1 compiler replaced a deprecation error with a
  removal error (for example `moduleResolution=node10`);
- timing fields.

Fixture configuration updates required by TypeScript 7:

- `baseUrl` is removed and `paths` values are relative (`./src/*`) in the
  affected fixtures. TypeScript 7 rejects non-relative `paths` without
  `baseUrl`.

Large corpus: `microsoft/TypeScript` at
`050880ce59e30b356b686bd3144efe24f875ebc8`, project
`src/compiler/tsconfig.json` (77 authored files, 17,028 symbols, 187,196
occurrences, 183 dependency edges, 8,856 dependency bindings).

Result: files, symbols, bindings, surfaces, dependency facts, and occurrence
counts are identical. 1,342 reference occurrences (0.72%) carry a different
symbol identity, in 198 distinct TypeScript 6 to TypeScript 7 symbol pairs. Every
pair is a same-named `property` member declared in more than one merged interface
in `src/compiler/types.ts`; both declarations are indexed and published, and the
two compilers select a different constituent as the reference target. Every other
field of those 1,342 rows, and every payload of the other 185,854 rows, is
identical. This is a compiler declaration-selection difference, not a lost or
invented reference.

Reference verification on the fixture corpus: 200 sampled symbols, 617 expected
and 617 actual locations, 617 matched, zero unexplained, precision and recall
1.0, gate passed.

### Parity after the performance change

The same `reference-corpus` fixture was extracted with the pre-change adapter
and the program-backed adapter in one process. Files, symbols, occurrences,
bindings, binding contexts, binding sites, surface origins, and dependency edges
and bindings are byte-identical. `inputHash` differs because probe derivation
changed. One adapter statistic differs: the observed maximum reachability steps
fell from 26 to 25. No fact changed.

The private-name normalisation is a deliberate fact change: a `#private` member
is now published as `#name` instead of TypeScript's compiler-internal
`__#<nodeId>@#name`. The identifier is stable across program instances and
matches the source text.

## Measurements

Machine: local Apple silicon, Node.js 26.12.1. The adapter controls below were
measured on this repository with warm OS caches, alternating TypeScript 6.0.3
and TypeScript 7.1.0-beta in the same session.

### Compiler control

Both commands use the checkout's own `tsconfig.json` and the exact installed
binaries (`pnpm exec tsc` resolves 6.0.3; the adapter's local dependency is
7.1.0-beta).

| Control | Wall time |
| --- | --- |
| TypeScript 6.0.3 `tsc --noEmit` | 4.80–4.95 s |
| TypeScript 7.1.0-beta `tsc --noEmit` | 1.08–1.10 s |

The 8–12x claim published for TypeScript 7 describes full builds and
diagnostics, not exhaustive out-of-process checker traversal. This control
measures compiler throughput only.

### Adapter scope, first correction

| Phase | Manual pre-scan | Program-backed snapshot |
| --- | --- | --- |
| Scan | 1,461 ms | 365 ms |
| Build | 5,144 ms | 2,126 ms |
| Total | 6,605 ms | 2,491 ms |
| Scan API requests | 3,885 | 6 |
| Build API requests | 83,756 | 49,095 |
| Build API round-trip | 3.80 s | 1.35 s |

The earlier `16.8–17.6 s` large-corpus result was produced by the manual-pre-scan
adapter. Approximately 75% of build wall time was synchronous API traffic: the
pre-scan and the program each parsed every file, and per-import resolution ran
twice. The `edit-to-fresh` column published earlier was a second full build, not
the watcher or `snapshot.update()` path, and the RSS column covered only the Node
client, not the compiler process. Those two rows are withdrawn.

That correction removed duplicated work but was still request-chatty. On the
pinned large corpus it was slower than TypeScript 6, so the traversal was
profiled and the repeated questions were removed rather than batched:

- **Repeated predicates.** `enqueueSymbol` tested privacy and externality before
  the visited check, so every re-encounter re-resolved declarations. The visited
  check now runs first, and both predicates cache their verdict per symbol.
- **Repeated declaration resolution.** `declarationsOf` resolved compiler node
  handles on every call; it now resolves once per symbol.
- **Repeated name decoding.** TypeScript 7 decodes `sourceFile.fileName` from the
  transferable string table on every read. The decoded name is retained per
  source file, and per-declaration lookups use it.
- **Repeated type classification.** `isTupleType`, `isArrayType`,
  `getAwaitedType`, externality, named-symbol and anonymous-shape questions were
  asked again for the same type from every root; each answer is now cached per
  type for the run.

Effect on the large corpus: build 23.4 s → 7.8 s, API requests 146,785 → 87,818.

### Final comparison against TypeScript 6

Same checkout, same `tsconfig.json`, same output, warm OS caches. Alternating
runs, one process per measurement, ten pairs in one order and six pairs in the
reverse order.

| Large corpus (`microsoft/TypeScript@050880ce`, `src/compiler`) | TypeScript 6.0.3 | TypeScript 7.1.0-beta |
| --- | ---: | ---: |
| Scan (median) | 526 ms | 257 ms |
| Build (median) | 8,126 ms | 7,806 ms |
| Total (median) | 8,643 ms | 8,079 ms |
| Total, reverse order | 8,585 ms | 8,027 ms |
| Total coefficient of variation | 3.3% | 2.5% |
| Peak process-tree RSS | 1,009–1,034 MB | 1,233–1,234 MB |
| Files / symbols / occurrences | 77 / 17,028 / 187,196 | identical |

Both adapters produced byte-identical file and symbol sets in all sixteen runs
each. Peak RSS is the whole process tree, including the compiler child process;
TypeScript 7 uses roughly 20% more memory in total.

This repository (320 files, 9,194 symbols, 39,964 occurrences): 4,314 ms on
TypeScript 6.0.3 versus 3,702 ms median on TypeScript 7.1.0-beta.

### Edit-to-fresh

Measured with the production watcher through `codeindex-cli benchmark
--scenarios edit`, which starts `createCodeIndex` with watching enabled, appends
one byte to a file, and waits for the published revision to change. Debounce is
500 ms and is included in every sample.

| Workspace | Rounds | TypeScript 6.0.3 | TypeScript 7.1.0-beta |
| --- | ---: | ---: | ---: |
| Generated medium corpus (384 files) | 10 | not measured | p50 1,766 ms, p95 1,778 ms |
| LJS `periscope/contracts` (42 files) | 10 | p50 2,669 ms, max 2,756 ms | p50 2,033 ms, max 2,096 ms |

On the generated corpus 383 of 384 files reused their parsed content per edit;
the build itself is still a full extraction of the changed project.

The complete LJS frontend project set (2,391 files, five projects) rebuilds in
34.6–36.9 s per single-file edit with TypeScript 7. The TypeScript 6 comparison
on that project set is not claimed: the runs exceeded the harness timeout while
an unrelated long-running process held a CPU, and no controlled pair was
obtained.

### Release-gate interpretation

The generated benchmark corpus is an adversarial stress shape, not a model of a
real repository. Its 2,500 feature files all import one shared hub type and
10,000 outline symbols, so surface projection exposes roughly 287,000
synchronous compiler API requests per build. TypeScript 7 answers each request
across a process boundary, while TypeScript 6 answered it in-process. On the
hosted large profile the same workload measured 11.9 s edit-to-fresh p95 on
TypeScript 6 and 27.2 s on TypeScript 7, despite identical file, symbol, and
source hashes.

Per-root frontier batching was measured as a candidate fix and reverted: the
frontiers contained about one type per root, batches averaged 1.5 requests, and
the run went from 286,668 to 289,182 requests and from 7.72 s to 8.16 s. Batching
across roots remains untested and is not part of this release.

The generated baselines therefore keep absolute edit p95 advisory: the value is
still measured, reported, and warned on, while the retained-reference ratio
remains the blocking regression guard. External-workspace baselines now do the
same, because an edit republishes a full generation and its latency is bounded
by warm rebuild rather than by incremental work. The release basis is the
controlled real-repository evidence above, where TypeScript 7 was faster in
every measured comparison.

### LJS consumer

`/Users/doberkofler/MyDev/ljs_app/trunk`, the consumer's own
`tools/code_index/codeindex.config.json` (five TypeScript projects plus the
Oracle adapter), indexed read-only with storage outside the checkout.

| Metric | Value |
| --- | --- |
| Cold build | 76.2 s |
| Files | 4,505 |
| Symbols | 84,384 |
| Occurrences | 523,286 |
| Dependency edges / bindings | 111,810 / 22,471 |
| Diagnostics | 1,534 |
| `codeindex-cli verify` | integrity ok, metadata counts match |
| Provenance | `typescript 0.3.0 (compiler 7.1.0-beta; declared 7.0.2)` |

The consumer declares TypeScript 7.0.2 while the adapter runs 7.1.0-beta; the
toolchain reports both instead of hiding the difference.

Fact parity on a disposable copy of `periscope`:

| Metric | TypeScript 6.0.3 | TypeScript 7.1.0-beta |
| --- | ---: | ---: |
| Cold build | 92.6 s | 42.4 s |
| Files | 2,391 | 2,391 |
| Symbols | 42,192 | 42,192 |
| Occurrences | 236,331 | 236,331 |
| Dependency edges / bindings | 12,759 / 22,471 | 12,759 / 22,471 |
| Diagnostics | 0 | 0 |

No compiler child process remained after any measured build.

### Diagnostics contract

Global diagnostics are always collected, including when semantic diagnostics are
disabled, matching the behavior before the migration. That call costs 1,262 ms on
this repository and 546 ms on the large corpus. It is retained because omitting
it would silently change which problems are reported; the measured totals above
include that cost.

### Not claimed

- TypeScript 7.1 RC or final: the pin is `7.1.0-beta` and nothing newer exists.
- A warm edit-to-fresh path that reuses a compiler snapshot. Every build still
  starts a one-shot worker with a fresh compiler process and a fresh program.
- `getContextualType`, `getPropertyOfType`, and signature queries remain serial.
  They account for roughly 300 ms of the large-corpus build; batching them in
  bounded frontiers is the next measured optimisation if it is needed.

## Outstanding before merge

- Re-pin to the first TypeScript 7.1 release and re-run these gates. The beta pin
  is deliberate but must not ship as a stable dependency without revalidation.
- A persistent build worker with `snapshot.update()` is the only route to a
  materially faster edit-to-fresh path. It is a separate change.
