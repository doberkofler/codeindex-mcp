# Oracle production qualification evidence (2026-10-25)

**Status: NOT READY.** Contract `oracle-o1@2` fails the reference-precision,
reference-recall, and dependency-recall gates on the current production corpus.
Declarations pass. This is the current production verdict. The controlled
10-case corpus remains a separate PASS
([`benchmark/oracle-controlled`](../oracle-controlled/README.md)); Phase 0,
Phase 6, and Phase 8 remain historical evidence and are not rewritten.

## Identities

| Item | Value |
|---|---|
| Runtime commit | `204af165a822314f688ab1cfde6fff956ebd7581` |
| Evidence commit | `671e00001b5944c82ad424d200679bb180d24578` (bundle, replay command, and reconciled documentation) |
| Package | `codeindex-mcp@0.7.0` |
| Node | `v26.10.0` |
| Oracle | 19c Enterprise Edition 19.0.0.0.0, version 19.19.0.0.0 |
| Schema | `LJ_UNITTEST` |
| Parser | `structural@5` with lexer `antlr4ng@3.0.16` |
| Contract | `oracle-o1@2`, truth policy `v4` |
| Contract hash | `77c0f1c462a298ded547230e8e85d3bc36dbedb84999160273663d03e62b1913` |
| Approved plan | `4bf6d3977cf0a8256f67aab4895f6bef81b24bd8804880bf7f56674240c4d00b` |
| Corpus | 1,244 files / 1,244 objects; 1,246 installed, 2 without usable source |
| Source hash | `2bb0da1e8151410432cfe55d30607ed229976b7ccfd974a97027ebeb220f7f2a` |
| Plan/run config hash | `8ba026c038fe53224ab378d0e898589f0da818c4e32a3f98cf6957a493e24065` |
| Report generation config hash | `b51a445cc2c6577116a19fb1614d79411fc8944cc2a161ef1df44a25b399e4ec` |
| Generation | `a0289975-88b8-476c-90c2-ce5ca0831502` |
| Truth identifier rows | 931,689 |
| `user-identifiers.csv` SHA-256 | `62a782264c460848b6730631fe5710b426329c527435293e4e5dc928f11c773d` |
| `user-dependencies.csv` SHA-256 | `c6783fb689113c668f7075ffbf358f6f9f8a040bfe26fd1df060e146fd891ce8` |
| External raw report SHA-256 | `ca34cd0675c2df1f051402b78b24f91672b74a778965bfa01a3270f5828f5d4d` |

The corpus is the live installed `USER_SOURCE` inventory frozen on 2026-10-25.
It is a **replacement** corpus, not a recovery of the historical SVN revision
`78950`; it has no SVN revision. The approved plan recompiled 1,244 target
objects with `PLSCOPE_SETTINGS='IDENTIFIERS:ALL'` and 189 dependents, and the
run left zero invalid objects.

## Result

| Section | Truth | Actual | Matched | Missing | Extra | Recall | Precision | Gate |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Declarations | 37,171 | 37,151 | 37,151 | 20 | 0 | 99.9462% | 100.0000% | PASS |
| References | 188,648 | 187,653 | 187,145 | 1,503 | 508 | 99.2033% | 99.7298% | **FAIL** |
| Package dependencies | 5,656 | 5,553 | 5,553 | 103 | 0 | 98.1789% | 100.0000% | **FAIL** |

Reference extras: 507 `false_positive` (counted against precision) and 1
`location_mismatch` (ignored). No `omitted_by_policy` or `outside_plscope`
extras were recorded.

Truth denominators reconstruct exactly:

```text
931,689 rows
  = 37,171 included declarations
  + 188,648 included references
  + 705,870 excluded

705,870 excluded
  = 165,687 unsupported_identifier_type
  + 63,270 package_reference
  + 359,620 missing_group_declaration
  + 13,125 declaration_initializer
  + 3,548 duplicate_fact
  + 73 omitted_ambiguous_overload
  + 100,547 ephemeral_declaration
```

The run emitted 931 ambiguity diagnostics. Declarations lose 19 `variable` and
1 `field`; references lose 1,269 `member_chain`, 157 `procedural`, 49
`static_sql`, 21 `iterator`, and 7 `pragma` rows.

## Performance

The production `structural@5` performance baseline for this frozen corpus is
retained in [`benchmark/oracle-performance`](../oracle-performance/README.md).
It measures the built CLI and worker path over one warmup and five measured
repetitions and records cold build, warm reuse, one-file edit-to-fresh, full
rebuild, queries, peak RSS, CPU, storage, and bundle size. Thresholds were
declared before measurement. This semantic result is not conditioned on the
performance verdict.

## Defects for follow-up

1. **Reference precision.** 507 false positives are reads of package-body
   Boolean variables and record fields in conditional expressions that PL/Scope
   does not record at that site. The classifier therefore counts them against
   precision instead of a tolerated class.
2. **Reference recall.** 1,269 missing member-chain rows concentrate in calls
   through JSON helper packages and in package-qualified routine invocations.
   Iterator (21) and pragma (7) references remain unsupported construct classes.
3. **Dependency recall.** 103 missing package edges. 17 edges have an authored
   reference in a package specification (package-qualified type anchors and
   default expressions); 86 have no authored reference in the indexed source
   and appear only in `USER_DEPENDENCIES`. A static-only adapter cannot emit the
   latter without a contract policy decision.
4. **Dependency gate policy.** With 86 compiler-inferred specification edges in
   the denominator, 99.5% dependency recall is not reachable by authored-source
   extraction. Either the contract must define those rows as out of scope, or
   O1 dependency recall must remain below the gate.
5. **Plan provenance.** The earlier approved plan omitted `PROCEDURE` from its
   truth exports. This evidence uses the corrected plan; the defect is fixed in
   `oracleLiveSql.ts` and covered by the frozen plan hash.

## Replay

Preflight and replay are database-free:

```bash
pnpm build
node dist/cli.mjs oracle-preflight --bundle benchmark/oracle-production-20261025/corpus.json
node dist/cli.mjs oracle-replay --bundle benchmark/oracle-production-20261025/corpus.json
```

Replay reconstructs the live project-context layout because the generation
configuration hash includes the context name. It compares every aggregate
count, ratio, identity, and exclusion count with `qualification.json`, ignoring
only the nondeterministic `generationId` and the bounded disagreement samples.
Samples are retained in the external root but are not committed because they
contain symbol names and workspace paths.

The live run was produced with:

```bash
pnpm qualify:oracle:live \
  --root "${CODEINDEX_EVIDENCE_ROOT:-$HOME/.local/share/codeindex-mcp}/oracle-live/ljs-user-source-20261025/source" \
  --output "${CODEINDEX_EVIDENCE_ROOT:-$HOME/.local/share/codeindex-mcp}/oracle-live/ljs-production-20261025" \
  --approval 4bf6d3977cf0a8256f67aab4895f6bef81b24bd8804880bf7f56674240c4d00b
```

Applying a plan is DDL and requires separate explicit approval; replay and
preflight never connect to Oracle.

## Comparison with retained evidence

| Evidence | Parser | Policy | Corpus | Declarations | References | Dependencies |
|---|---|---|---|---|---:|---:|
| Phase 0 (2026-10-19) | structural | `v1` | SVN 78950, 1,237 files | 98.3956% / 99.9662% | 58.5206% / 99.4259% | 98.1734% / 100% |
| Phase 6 (2026-10-21) | `structural@5` | `v2` | SVN 78950, 1,237 files | 99.9647% / 99.9973% | 99.9278% / 100% | not published |
| Phase 8 (2026-10-20) | `structural@1` | `v2` | SVN 78950, 1,237 files | 95.5394% / 99.9711% | 57.4956% / 99.3464% | 98.1734% / 100% |
| **This run** | `structural@5` | `v4` | live installed, 1,244 files | **99.9462% / 100%** | **99.2033% / 99.7298%** | **98.1789% / 100%** |

Phase 6 is not a like-for-like baseline:

- **Corpus.** 1,237 SVN files versus 1,244 live installed objects, with two
  installed objects lacking usable source and no SVN revision for the
  replacement.
- **Policy.** Phase 6 counted parameters and routine locals as declarations and
  removed ambiguous `CALL` rows outside the gate. `v4` excludes 100,547
  parameter/local declarations as `ephemeral_declaration`, 13,125 initializers,
  and 3,548 duplicate facts, so the declaration denominator falls from 126,844
  under `v2` to 37,171 under `v4`. The reference denominator rises from 186,877
  to 188,648 because of the corpus change and the in-gate ambiguity rule.
- **Ambiguity.** Phase 6 removed 1,420 raw `CALL` rows externally. This run
  omits 73 rows as `omitted_ambiguous_overload` from 931 diagnostics. Under
  `v4`, a larger share of raw `CALL` rows is already excluded by
  `missing_group_declaration` before ambiguity is applied.
- **Result.** The declaration precision extra recorded in Phase 6 is gone; the
  earlier export in this campaign omitted `PROCEDURE` entirely, which produced a
  procedure extra until the corrected plan was applied. Reference precision
  regresses from 100% to 99.7298% and reference recall from 99.9278% to 99.2033%
  on the larger live corpus.
- **Dependencies.** Phase 8 reported 5,536 / 5,639 (98.1734%) with the same 103
  missing edges. This run reports 5,553 / 5,656 (98.1789%): the corpus adds 17
  truth edges and 17 matches, while the 103 missing edges are unchanged.

No gate threshold was relaxed. Phase 6 and Phase 8 artifacts are not modified.

## Files

- `corpus.json` — descriptor and identities.
- `corpus.sha256` — every frozen source file.
- `units.json` — path/object/source-hash mapping.
- `plscope.sha256` — external plan, run, truth exports, logs, and raw report.
- `qualification.json` — bounded aggregate report; disagreement samples are
  retained only in the external root, so the committed projection has a
  different SHA-256 from the raw report.
