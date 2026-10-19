# Oracle ANTLR Phase 8 Quality Evidence

**Status:** Phase 8 integration is implemented. Production remains bound to the
structural parser. The ANTLR parser is selectable only for qualification.

**Corpus:** frozen Phase 0 LJS snapshot, SVN `78950`, 1,237 files

**Truth:** PL/Scope policy `v2`

**Reports:** `structural.json`, `antlr.json`, `differential.json`

This phase answers one question: does the ANTLR parser produce better facts than
the structural parser under identical truth and gates? It does not switch
production.

## Method

Both parsers were run through the normal qualification pipeline with separate
databases, the same frozen source snapshot, the same truth exports, and truth
policy `v2`:

```bash
node dist/cli.mjs qualify --extractor oracle \
  --root "$EVIDENCE/workspace" \
  --project-file "$EVIDENCE/workspace/manifests/qualification-index.json" \
  --database "$TMP/structural.sqlite" \
  --identifiers "$EVIDENCE/user-identifiers.csv" \
  --dependencies "$EVIDENCE/user-dependencies.csv" \
  --units "$EVIDENCE/plan.json" \
  --parser structural \
  --output benchmark/oracle-phase8/structural.json

NODE_OPTIONS=--max-old-space-size=16384 node dist/cli.mjs qualify --extractor oracle \
  --root "$EVIDENCE/workspace" \
  --project-file "$EVIDENCE/workspace/manifests/qualification-index.json" \
  --database "$TMP/antlr.sqlite" \
  --identifiers "$EVIDENCE/user-identifiers.csv" \
  --dependencies "$EVIDENCE/user-dependencies.csv" \
  --units "$EVIDENCE/plan.json" \
  --parser antlr \
  --output benchmark/oracle-phase8/antlr.json
```

The ANTLR run needs a larger V8 heap because the full corpus parse and the
qualification fact load overlap. `NODE_OPTIONS=--max-old-space-size=16384` is
required on this corpus; the structural run does not need it.

`benchmark/oracle-phase8/differential.json` is generated from the two reports and
the two databases:

```bash
node --experimental-strip-types scripts/compareOracleQualification.ts \
  --structural benchmark/oracle-phase8/structural.json \
  --antlr benchmark/oracle-phase8/antlr.json \
  --structural-database "$TMP/structural.sqlite" \
  --antlr-database "$TMP/antlr.sqlite" \
  --output benchmark/oracle-phase8/differential.json
```

## Aggregate results

| Category | Structural recall | ANTLR recall | Δ recall | Structural precision | ANTLR precision | Δ precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Declarations | 95.5394% | 96.9403% | **+1.4009 pp** | 99.9711% | 99.9659% | -0.0053 pp |
| References | 57.4956% | 69.1314% | **+11.6358 pp** | 99.3464% | 99.3900% | +0.0436 pp |
| Dependencies | 98.1734% | 97.9784% | -0.1951 pp | 100% | 100% | 0 |

| Category | Structural missing / extra | ANTLR missing / extra |
| --- | ---: | ---: |
| Declarations | 5,658 / 41 | 3,881 / 48 |
| References | 200,464 / 2,832 | 145,586 / 2,567 |
| Dependencies | 103 / 0 | 114 / 0 |

Neither parser passes the adoption gates. Precision must be exactly 100%, and
declaration, reference, and dependency recall must each reach 99.5%. ANTLR
improves declaration and reference recall but does not reach those gates and
regresses dependency recall.

## Stratified results

### Declarations

| Kind | Truth | Structural recall | ANTLR recall | Δ recall |
| --- | ---: | ---: | ---: | ---: |
| Cursor | 236 | 66.9492% | **100%** | **+33.0508 pp** |
| Variable | 30,345 | 85.1541% | 91.8603% | **+6.7062 pp** |
| Constant | 10,972 | 99.8359% | 99.8451% | +0.0091 pp |
| Parameter | 59,016 | 98.8156% | 98.4580% | -0.3575 pp |
| Function | 8,851 | 100% | 99.6159% | -0.3841 pp |
| Procedure | 8,271 | 100% | 98.9602% | -1.0398 pp |
| Package | 1,214 | 100% | 99.8353% | -0.1647 pp |
| Collection type | 453 | 100% | 99.5585% | -0.4415 pp |
| Field | 6,531 | 94.5185% | 94.4878% | -0.0306 pp |
| Exception, record type, subtype | 955 | 100% | 100% | 0 |

### References

| Stratum | Truth | Structural recall | ANTLR recall | Δ recall | Structural precision | ANTLR precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Member chain | 137,917 | 42.9447% | 80.7196% | **+37.7749 pp** | 99.7558% | 99.5333% |
| Iterator | 7,973 | 0% | 34.1277% | **+34.1277 pp** | 100% | 95.6415% |
| Pragma | 19 | 0% | **100%** | **+100 pp** | 100% | 100% |
| Procedural | 294,058 | 64.0639% | 64.1642% | +0.1003 pp | 99.0629% | 99.2452% |
| Static SQL | 31,643 | 73.6529% | 73.2453% | -0.4077 pp | 99.4877% | 99.6517% |
| Type anchor | 21 | 100% | 100% | 0 | 100% | 100% |

ANTLR's reference gain is concentrated in member chains and iterators. Static
SQL and procedural references are essentially unchanged, so the reference recall
ceiling is still unresolved.

## Parser-only facts

Exact key differences between the two indexed generations:

| Fact class | Only structural | Only ANTLR |
| --- | ---: | ---: |
| Definitions | 563 | 2,347 |
| References | 2,544 | 57,157 |
| Package dependencies | 11 | 0 |

Structural-only definitions are mostly parameters (281), variables (153),
procedures (86), and functions (34). Structural-only references are mostly
variables (953), functions (618), and parameters (503). ANTLR-only references are
dominated by record fields (52,464).

The 11 structural-only package dependencies all come from three files:
`PACKAGES/las_rep_sijournal.pkb` (6), `PACKAGES/las_mod_storedreport_run.pkb`
(4), and `PACKAGES/las_mod_language_data.pkb` (1). ANTLR produced no package
dependency that structural did not produce.

## Disagreement adjudication

### ANTLR wins

- Member-chain resolution: +37.7749 pp recall, the single largest quality gain.
- Iterator declarations and references: structural emits no iterator references;
  ANTLR resolves 34.1277% of iterator truth.
- Pragma arguments: ANTLR matches all 19 truth rows and removes 467 structural
  extras that were previously classified as `outside_plscope`.
- Cursor declarations: 66.9492% → 100% recall.

### ANTLR losses

The losses cluster in files with ANTLR parse errors, not in arbitrary semantic
drift. The ANTLR generation records 298 parse diagnostics (code `9102`) across 16
files. The top loss files match that set:

| File | Structural-only definitions | Structural-only references | ANTLR parse diagnostics |
| --- | ---: | ---: | ---: |
| `PACKAGES/ods_uti_pdf.pkb` | 265 | 754 | 26 |
| `PACKAGES/las_rep_sijournal.pkb` | 67 | 277 | 40 |
| `PACKAGES/las_int_timesheet.pks` | 55 | — | 16 |
| `PACKAGES/las_uti_web_push.pkb` | 50 | 174 | 40 |
| `PACKAGES/las_int_timesheet.pkb` | 36 | — | 12 |

Representative parser diagnostics:

- `extraneous input 'PLS_INTEGER' expecting {<EOF>, '/', ';'}`
- `mismatched input '(' expecting {'DEFAULT', 'NOT', 'NULL', ':=', ';'}`
- `missing {<EOF>, ';'} at 'VARCHAR2'`
- `no viable alternative at input 'CHAR)'`
- `extraneous input 'date' expecting {<EOF>, '/', ';'}`

These are grammar gaps or recovery boundaries in the pinned grammar; they are
not evidence that the structural facts are better. They are the fix backlog for
any later adoption.

### False positives

| Extra class | Structural | ANTLR | Δ |
| --- | ---: | ---: | ---: |
| Declarations: false positive | 35 | 42 | +7 |
| Declarations: outside PL/Scope | 6 | 6 | 0 |
| References: false positive | 1,784 | 2,001 | +217 |
| References: location mismatch | 428 | 442 | +14 |
| References: omitted by policy | 162 | 116 | -46 |
| References: outside PL/Scope | 458 | 8 | -450 |

ANTLR reduces reference extras overall (2,832 → 2,567) and removes almost all
`outside_plscope` extras, but classifies more remaining extras as false
positives. Declaration precision regresses slightly.

## Bundle isolation

Parser selection is runtime-selected only inside qualification. Production MCP
and default CLI startup remain structurally bound. The production MCP bundle is
2,039.17 kB raw / 320.47 kB gzip and contains no generated ANTLR parser. The CLI
entry is 292.91 kB / 77.75 kB gzip with a shared Oracle structural chunk of
1,917.96 kB / 290.17 kB gzip. The ANTLR extractor is emitted as a separate
7,528.18 kB / 1,227.40 kB gzip chunk and is loaded only by `--parser antlr`.

These sizes are not a performance claim. Phase 7 remains the authoritative
performance evidence; its candidate bundle contains only the ANTLR adapter.

## Decision

**No parser switch.** Under the existing gates:

- neither parser reaches exactly 100% precision;
- neither reaches 99.5% declaration or reference recall;
- ANTLR dependency recall is 0.1951 pp lower, and its dependency set is a strict
  subset of the structural set;
- ANTLR declaration precision is 0.0053 pp lower.

The ANTLR quality gain is real but concentrated in member chains, iterators, and
pragmas. It does not justify violating the no-compensation rule or adopting a
parser with a dependency regression. Phase 8 therefore keeps the structural
parser in production and records the ANTLR parse-error files as the semantic-fix
backlog. Incremental-only adoption remains blocked by the same quality gates,
independently of the Phase 7 performance result.

## Integrity

| Artifact | SHA-256 |
| --- | --- |
| `structural.json` | `86ec5e62e7a9600b05d7e8a1cef6e2493cff5a8802cfd1674cb4fde206ecc3f3` |
| `antlr.json` | `c671887b1d8a48a4f02eadaf15bbc41b7eb4485edcadae0eee083211f9a0a9b5` |
| `differential.json` | `d005e479cc7717f31cf87eae937f825967e24d14ea7256fc8012c92a0e5ff1e6` |

Source hash:
`dfae2b41a2595d3e83065b9c5807b596f1b43e7cf8fd634958e89e86cfebf2d7`.

Truth exports:

| Export | SHA-256 |
| --- | --- |
| `user-identifiers.csv` | `3161b621ab798b124f84d03b6acf84bdcda45f902b695d16d253616820af7470` |
| `user-dependencies.csv` | `f84ee12ee1111c843876d9c999cbf2ba69facf45575003d014f822c5fc2d446f` |
| `plan.json` | `4f6a114d7b5b45cad3a6015ccc261ff808795a61c32820f4479f6c5835bc2564` |

The databases are not committed; they are rebuilt by the commands above.
