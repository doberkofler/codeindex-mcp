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
- Program construction: `API.createProgram` is the authoritative resolution
  pass. It parses every reachable file and probes every candidate path through
  the recorder, so the manifest describes exactly what the facts depend on.
- Program retention: the snapshot keeps that program and `loadTypeScriptProject`
  reuses it. Extraction therefore queries one program instead of building a
  second one.
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

- The snapshot owns one compiler API process and one program per project.
  `snapshot.dispose()` releases the programs and the API process.
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
`src/compiler/tsconfig.json` (77 authored files, 17,028 symbols, 187,190
occurrences, 22 dependency edges).

Result: files, symbols, bindings, surfaces, dependency facts, and occurrence
counts are identical. 1,342 reference occurrences (0.7%) carry a different symbol
identity. In every sampled case the reference is a property access whose declared
name exists in more than one merged interface; TypeScript 6 and TypeScript 7
select different constituent declarations of the same merged property. Both
declarations are indexed and published. This is a compiler declaration-selection
difference, not a lost or invented reference.

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

### Adapter scope

| Phase | Before (manual pre-scan) | After (program-backed snapshot) |
| --- | --- | --- |
| Scan | 1,461 ms | 365 ms |
| Build | 5,144 ms | 2,126 ms |
| Total | 6,605 ms | 2,491 ms |
| Scan API requests | 3,885 | 6 |
| Build API requests | 83,756 | 49,095 |
| Build API round-trip | 3.80 s | 1.35 s |

The earlier `16.8–17.6 s` large-corpus result was produced by the
manual-pre-scan adapter. Approximately 75% of build wall time was synchronous
API traffic: one `getGlobalDiagnostics` call cost 1.17 s, the pre-scan and the
program each parsed every file, and per-import resolution ran twice. The
`edit-to-fresh` column published earlier was a second full build, not the
watcher or `snapshot.update()` path, and the RSS column covered only the Node
client, not the compiler process. Those two rows are withdrawn.

What this change addresses:

- **Duplicated work.** Program construction replaced the hand-written parse and
  resolution walk in both scan and build, and the resulting program is reused for
  extraction.
- **Unconditional semantic work.** `getGlobalDiagnostics` now runs only when
  semantic diagnostics are enabled.
- **Repeated resolution.** Dependency extraction memoises resolution by mode,
  directory, and specifier.
- **Serial symbol lookup.** One batched request per file builds an identifier
  symbol map shared by publication, occurrence extraction, and reachability.
  Scalar `getSymbolAtLocation` calls fell from 30,515 to 2,650 per build.
- **Unstable identity.** Manifest probes and private-member names are now
  deterministic.

### Not yet re-measured

The large corpus (`microsoft/TypeScript` at
`050880ce59e30b356b686bd3144efe24f875ebc8`, `src/compiler/tsconfig.json`) was not
present in this environment after the fix, so its new cold-build and
edit-to-fresh numbers are not claimed here. The large-corpus parity result from
before the fix still stands, but both performance and parity must be re-run on
that corpus before merge.

Memory is process-tree RSS including the compiler child. It has not been
re-measured after the fix; the earlier Node-only figure is not comparable.

Soak: three consecutive large-corpus builds and ten fixture builds in one Node
process kept RSS flat, kept heap usage flat, and left zero compiler child
processes after each build.

Every build still runs in a one-shot worker with a fresh compiler process. A
genuine warm edit-to-fresh improvement requires a persistent build worker and
`snapshot.update()`, which is a separate change.

## Outstanding before merge

- Re-run cold-build and edit-to-fresh benchmarks on the pinned large corpus,
  measuring the whole process tree and labelling warm-cache runs honestly.
- Re-run large-corpus fact parity. The private-name normalisation is expected to
  improve its output and must be recorded.
- TypeScript 7.1 RC/final must be revalidated before a stable release; the beta
  pin is deliberate.
- The LJS consumer repository was not available in this environment. End-to-end
  LJS multi-adapter indexing with truthful provenance must be run before merge.
- `getContextualType`, `getPropertyOfType`, and alias queries remain serial.
  Batching them in bounded frontiers is the next measured optimisation if the
  large corpus still regresses.
