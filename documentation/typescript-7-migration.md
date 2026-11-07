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

### JSDoc type nodes

TypeScript 7 exposes the synthesized type nodes that JSDoc comments attach to a
declaration to `forEachChild`. Those nodes live inside the comment, before the
declaration they annotate. Emitting them as symbols produced definitions outside
their owner's extent, so Material UI failed finalization with 13 S3, 13 O2, and
5 L1 violations. The adapter's `forEachChild` seam skips JSDoc-flagged nodes and
reparsed JSDoc type nodes that start before their parent, restoring the
TypeScript 6 traversal contract: documentation types are not authored
declarations, symbols, or references.

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

## Persistent worker and warm snapshot

The adapter and the build worker now keep compiler state across refreshes.

- One persistent build worker per index stays alive between attempts. Its
  adapter modules are loaded once, so the TypeScript session and compiler child
  process survive an authored edit.
- `compilerSession.ts` owns one `ts.API`, one `ts.Snapshot`, and the parsed
  projects per workspace. `createTypeScriptInputSnapshot` acquires a lease on
  that session instead of starting a new compiler for every scan and build.
- Authored changes are applied with `snapshot.update({fileNotifications,
  ensurePrograms: true})`. The previous snapshot is disposed as soon as the
  replacement exists, and the content cache is trimmed to the manifest inputs.
- The session is rebuilt from scratch when the project file, project file set,
  compiler identity, lockfiles, workspace configuration, or any declaration or
  external input changes. Authored source is the only category allowed to reach
  the update path.
- The worker is stopped after `freshness.workerIdleMs` without requests. A
  process-tree RSS sample, which includes compiler child processes, restarts the
  worker when it exceeds `freshness.workerMaxRssBytes`. The adapter session has
  its own `options.warmIdleMs` eviction.
- Benchmark resources now report process-tree RSS next to process RSS, so the
  compiler child process is included in the memory figures. Stage timings,
  event-to-publication p50/p95, and edit-to-fresh latencies keep their existing
  report fields.

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

The request-scheduler correction was compared directly with the scalar adapter
at `f4d186c`. All serialized fact collections were byte-identical for
`reference-corpus`, `dependency-cases`, `simple-project`,
`publication-project`, `typescript-require`, `javascript-project`, and the
2,704-file generated large corpus. This comparison includes files, symbols,
occurrences, every publication collection, dependency facts, diagnostics, and
adapter statistics; timing and the non-serializable validation callback were
excluded.

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

### Persistent worker measurement

Local Apple silicon, Node.js 26.12.1. The generated `small` profile (34 files)
was measured with the same command from commit `1f311e2` (one worker and one
compiler per attempt) and from the persistent-worker change:

```bash
codeindex-cli benchmark --profile small --scenarios cold,warm,rebuild,edit \
  --iterations 5 --edit-rounds 3
```

| Metric | Before (`1f311e2`) | Persistent worker |
| --- | ---: | ---: |
| Cold build scan | 557 ms | 61 ms |
| Edit build `compilerMs` | 30 ms | 3 ms |
| Edit build `extractionMs` | 137 ms | 78 ms |
| Edit-to-fresh p50 | 859 ms | 759 ms |
| Edit-to-fresh p95 | 900 ms | 838 ms |
| Process-tree RSS peak, external sample | 407 MB | 475 MB |

The edit path still republishes a complete generation. The gain is the retained
compiler process and snapshot, not delta extraction. Peak process-tree RSS is
higher because the worker and its compiler child stay resident; the idle timeout
and RSS ceiling bound that cost.

A 102-event soak on the same profile (100 single edits plus one burst) passed all
gates with p50 1,275 ms and p95 1,285 ms. Process-tree RSS moved from 450 MB at
the first event to 533 MB at the last and peaked at 533 MB, below the 2 GiB
ceiling; the idle window then releases the session. This is a small generated
corpus, not the pinned public corpus, so the release-reference campaign in
"Outstanding before merge" still applies.

### Release-gate interpretation

The generated benchmark corpus exposed an adapter defect rather than a reason to
weaken the gate. Its 2,500 feature files share enough types to amplify the
cost of a direct TypeScript 6-style scalar traversal over TypeScript 7's process
boundary.

TypeScript 7's synchronous API provides generator forms of long-running checker
operations. `API.batch(...)` advances those generators together, deduplicates
equal requests, and sends each dependency round as one batch. The adapter had
instead drained one root completely before starting the next. Per-root frontier
prefetching did not fix that execution model; the correct unit is one resumable
generator per published root, scheduled together across roots.

The production adapter now uses that model for surface projection and also
schedules module-export discovery, alias resolution, and bounded contextual
occurrence resolution in shared rounds. Per-file bulk lookup resolves authored
identifiers. Projects above 250,000 identifiers preserve that per-file request
cadence but stop retaining the project-wide occurrence map; references are then
resolved and consumed in bounded groups. Those projects also evict the retained
compiler session after extraction so the program graph cannot overlap fact
insertion; smaller projects keep warm-session reuse. This avoids cold-build and
forced-rebuild OOM on VS Code's 2.69-million-identifier project without changing
heap limits. On the generated large corpus, compiler transport requests fell
from 286,669 to 21,000 and transport overhead from about 2,240 ms to 339 ms.
Extraction fell from about 4,950 ms to 3,272–3,360 ms and passes the unchanged
3,500 ms TypeScript 6 envelope. No benchmark threshold, timeout, or heap limit
changed.

The oversized-project path also retains only syntax-planned candidate symbols
after the 250,000-identifier ceiling. A declaration-heavy 250,001-identifier
regression previously made 2,223 compiler requests because candidate collection
fell back to scalar lookups; planned lookup and batched candidate aliases reduce
that case to 176 requests without changing its facts.

TypeScript 7 names computed unique-symbol members as
`__@name@<compiler-instance-id>`. Two otherwise identical VS Code extractions
therefore changed 25 path digests, and the in-place revision cascade rewrote most
of the reference graph. Candidate names and surface addresses now remove the
instance suffix only for symbols carrying `CheckFlags.Late`; an authored quoted
name with the same textual shape remains unchanged. Two fresh VS Code digest
reports are byte-identical after normalization.

The final clean VS Code run used a fresh database and the production benchmark
path. Cold build completed in 202.2 s; forced rebuild completed in 99.5 s. The
rebuild spent 65.2 s extracting, 9.5 s inserting, and 9.3 s verifying. Before
unique-symbol normalization, the same local run spent 369.5 s inserting and
499.7 s overall. Both revisions published 4,935 files, 165,591 symbols,
1,377,975 occurrences, 63,373 dependency edges, and no diagnostics. The
normalization intentionally replaces compiler-instance text; all other checked
fixture and generated-corpus facts retain their prior serialized form.

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
- A release-reference before/after comparison for the persistent worker. The
  adapter now keeps the compiler session and updates it with `snapshot.update()`,
  but the pinned-public edit-to-fresh table above was measured before that
  change, so it must not be read as evidence for the warm path.

## Outstanding before merge

- Re-pin to the first TypeScript 7.1 release and re-run these gates. The beta pin
  is deliberate but must not ship as a stable dependency without revalidation.
- Re-run the pinned-corpus before/after campaign for the persistent worker on
  the release-reference machine. The previous edit-to-fresh numbers measured a
  fresh worker and a fresh compiler per edit.
