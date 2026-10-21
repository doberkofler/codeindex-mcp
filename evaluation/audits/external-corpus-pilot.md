# External corpus pilot: TypeScript, VS Code, and Material UI

Model-free pilot required by
[strategy §5](../../documentation/mcp-evaluation-strategy.md#5-evaluation-data) and
[§13](../../documentation/mcp-evaluation-strategy.md#13-immediate-priorities). It compares
setup cost, usable semantic cases, build time, fixture stability, and distinct evidence,
then selects one external repository. No model call, case run, or source mutation was
involved.

- Date: 2026-10-21.
- Selected corpus: `external-material-ui`, pinned in
  [`../corpora/external-material-ui.json`](../corpora/external-material-ui.json).
- Benchmark evidence: retained public-project suite runs `public-20261019-1` and
  `public-20261019-2`, produced at CodeIndex commit
  `b9c35968c7fc13a360fc2782ccff77a73c107a0e` on the same machine and pinned revisions.
- Source identity: re-verified on 2026-10-21; every `HEAD` and lock hash equals
  `benchmark/suites/typescript-public.json` and the prepared-project manifest.

## Method

1. Re-verify each prepared checkout: `git rev-parse HEAD` and `sha256sum` of the
   lockfile must equal the pinned suite entry.
2. Use the two retained benchmark passes as the comparable build evidence. They ran the
   same revisions, project files, lock hashes, Node, machine, and artifacts; each pass
   records cold build, warm reuse, warm rebuild, peak RSS, database size, and indexed
   counts. The evidence is outside the repository and is not cited as a current-artifact
   claim.
3. Parse every project file with TypeScript 6.0.3 and count source extensions and semantic
   patterns read-only. These counts are a candidate pool, not admitted cases: every future
   case still needs E0 truth and grep admission under strategy §6.
4. Compare the five pilot dimensions and select the cheapest repository that adds
   material coverage rather than reputation or raw size.

## Setup cost

Measured checkout footprint includes `.git` and installed dependencies; it is paid once
per prepared machine.

| Candidate | Project file | Lockfile and install | Checkout | Dependencies | Indexed files | Symbols | Occurrences |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | `src/compiler/tsconfig.json` | `package-lock.json`, `npm ci --ignore-scripts` | 1.9 GiB | 153 MiB | 77 | 33,134 | 260,291 |
| VS Code | `src/tsconfig.json` | `package-lock.json`, `npm ci --ignore-scripts` | 1.1 GiB | 487 MiB | 4,935 | 293,866 | 1,864,302 |
| Material UI | `packages/mui-material/tsconfig.json` | `pnpm-lock.yaml`, `pnpm install --frozen-lockfile --ignore-scripts` | 2.0 GiB | 1.3 GiB | 1,069 | 17,464 | 68,554 |

Material UI has the largest one-time install. TypeScript has the smallest dependency tree
but indexes a dense 77-file compiler project rather than an application graph.

## Build time and fixture stability

Values are the two retained passes. Counts were identical in both passes; the percentage
is the larger cold-build difference between the passes.

| Candidate | Cold build | Warm reuse | Warm rebuild | Peak RSS | Database | Cold-build spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 6.5 s / 6.6 s | 129 / 130 ms | 7.2 s / 6.7 s | 1.3 GiB | 474 MiB | 2.4% |
| VS Code | 70.4 s / 69.9 s | 478 / 421 ms | 75.4 s / 74.3 s | 5.3 GiB | 4.01 GiB | 0.7% |
| Material UI | 9.1 s / 9.0 s | 167 / 166 ms | 8.8 s / 8.7 s | 1.8 GiB | 164 MiB | 2.0% |

All three are stable enough for a pinned suite. Checkout cleanliness differs:

- TypeScript is clean after preparation.
- VS Code carries two operator-created untracked files under `src/`, which a harness
  isolation check rejects until removed.
- Material UI carries 354 untracked generated declaration files; none are inside
  `packages/mui-material/`, but whole-checkout isolation still requires `git clean -fd`
  before a campaign. No tracked source differs at any candidate.

## Usable semantic cases

Counts come from parsing every file named by each project file; declaration files are
counted as files but never as declarations. `implements` includes interface extension
clauses. Duplicate exported names count names exported by more than one file, which is the
pool for shadowed-identity cases. Parsed files exceed indexed files where the project names
declarations or files the extractor excludes.

| Pattern | TypeScript | VS Code | Material UI |
| --- | ---: | ---: | ---: |
| Parsed project files | 77 | 5,113 | 1,214 |
| TypeScript `.ts` | 77 | 5,113 | 592 |
| TSX `.tsx` | 0 | 0 | 98 |
| JavaScript `.js` | 0 | 0 | 524 |
| Renamed re-exports | 0 | 11 | 655 |
| Star re-exports | 75 | 16 | 714 |
| Barrel `index` modules | 0 | 1 | 149 |
| Default exports | 0 | 12 | 482 |
| Type-only imports | 0 | 617 | 65 |
| `implements` / interface extension | 451 | 4,631 | 148 |
| Duplicate exported names | 106 | 1,089 | 54 |

Material UI is the only candidate that supplies every pattern the frozen suite must cover:
renamed re-exports, multi-hop barrel chains, shadowed names, interface implementations,
type-only imports, default exports, and multi-project package boundaries. VS Code supplies
scale, type-only imports, implementations, and duplicate names, but no TSX, renamed
re-exports, default exports, or meaningful barrel pool. TypeScript supplies dense references
and implementations but almost no module-boundary evidence and no TSX or JavaScript.

Exact expected file sets and grep-admission measurements do not exist yet; they arrive with
the case-building and freeze steps. A pattern count is a pool, never a semantic win.

## Distinct evidence

- Controlled fixture: mechanically admitted semantic patterns in a reviewed, tiny
  workspace.
- CodeIndex repository snapshot: realistic tasks in this project's naming and architecture.
- Material UI: a real monorepo with TSX components, JavaScript modules, renamed and star
  re-exports, deep barrel chains, default exports, and package boundaries. It generalizes
  beyond CodeIndex naming without the cost of a compiler-scale scan.

TypeScript would mostly repeat dense TypeScript references. VS Code would add scale, but
its 70 s build, 5.3 GiB peak RSS, and 4 GiB database make every campaign roughly eight times
more expensive than Material UI for coverage already supplied by the controlled fixture and
the repository snapshot.

## Decision

Select **Material UI** as `external-material-ui`.

It is the cheapest repository that adds material coverage. It builds in about 9 s, needs
1.8 GiB peak RSS and a 164 MiB database, and is the only candidate with TSX, JavaScript,
renamed re-exports, barrels, default exports, and package boundaries. TypeScript is 2.6 s
faster and 0.5 GiB lighter at peak, but its 474 MiB database is 2.9 times larger and it adds
almost no coverage beyond dense TypeScript references. VS Code is 7.7 times slower to build,
uses 3 times the peak memory, and produces a 25 times larger database; its extra scale does
not justify that cost at the pilot stage.

The selected manifest pins the repository, revision, project file, lock hash, preparation,
truth authority, limitations, and empty case hashes. Cases and hashes are added only by the
suite freeze.

## Reproduction

```bash
pnpm benchmark:typescript:public:prepare
pnpm benchmark:typescript:public -- --output ~/codeindex-evidence/public-<date>
```

The prepared checkout must remain at the pinned revision and lock hash. A new benchmark
pass replaces the directional build numbers; it does not change this selection unless the
five pilot dimensions change materially. `git -C <checkout> status --porcelain` and
`sha256sum <checkout>/<lockfile>` reproduce the identity checks.

## Limitations

- The build comparison is retained evidence from commit `b9c3596`, not a fresh measurement
  of the current artifact. Publication-fact enforcement changed after that evidence, so a
  new campaign must re-measure build time before using it as a gate.
- Material UI installation leaves untracked generated declarations outside the selected
  project scope. Preparation must clean them so the harness sees a clean checkout.
- The 524 JavaScript modules mean this corpus does not produce TypeScript-only evidence;
  every claim remains TypeScript-adapter-scoped, but the publication form is mixed.
- Candidate pattern counts are not E0-admitted cases. No case enters the frozen suite until
  its exact file set and grep admission are recorded.
