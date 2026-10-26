# Oracle production qualification evidence (2026-10-26)

**Status: REFERENCE GATES PASS; DEPENDENCY GATE FAILS.** Contract `oracle-o1@3`
(truth policy `v5`) passes reference precision and reference recall on the
production corpus. Declarations pass. Package dependencies remain below the
gate and are owned by [#101](https://github.com/doberkofler/codeindex-mcp/issues/101).
The 2026-10-25 bundle is retained as historical evidence for contract
`oracle-o1@2` and is not rewritten.

## Identities

| Item | Value |
|---|---|
| Runtime commit | uncommitted working tree based on `885fdaa` |
| Package | `codeindex-mcp@0.7.0` |
| Node | `v26.10.0` |
| Oracle | 19c Enterprise Edition 19.0.0.0.0, version 19.19.0.0.0 |
| Schema | `LJ_UNITTEST` |
| Parser | `structural@5` with lexer `antlr4ng@3.0.16` |
| Contract | `oracle-o1@3`, truth policy `v5` |
| Contract hash | `ead99963af1b78ca968256e66a0a5bd01cd4e80d3e781fbe0b50e8d1749357d7` |
| Approved plan | `97c796a2f6a3b228e8a5f34af1c0b6c3087a908deba7f2d14a513299cbdf7ce0` |
| Corpus | 1,244 files / 1,244 objects; 1,246 installed, 2 without usable source |
| Source hash | `2bb0da1e8151410432cfe55d30607ed229976b7ccfd974a97027ebeb220f7f2a` |
| Plan/run config hash | `8ba026c038fe53224ab378d0e898589f0da818c4e32a3f98cf6957a493e24065` |
| Report generation config hash | `b51a445cc2c6577116a19fb1614d79411fc8944cc2a161ef1df44a25b399e4ec` |
| Generation | `e4700753-82e3-421f-94e0-20fed4b48aa9` |
| Truth identifier rows | 931,686 |
| `user-identifiers.csv` SHA-256 | `4a980106361b7a336071a4265be22d512549c56b9af3475f2d7ed9b89ab9bc09` |
| `user-dependencies.csv` SHA-256 | `c6783fb689113c668f7075ffbf358f6f9f8a040bfe26fd1df060e146fd891ce8` |
| Committed report SHA-256 | `5c815ebd4ad18af4be74defe70a72bd8ea4bfb958ee47e2fd21ce4a5c3e3c19d` |
| External raw report SHA-256 | `f1a82dda53de946d93c4ecb5ca31d16b45ebe1deac9008e844cf167c7529d7dd` |

The source snapshot is byte-identical to the 2026-10-25 replacement corpus
(`2bb0da1e…`, 1,244 files and units, one descriptor checksum per file). The
truth export was regenerated from the same objects: 931,686 rows instead of
931,689, a difference of three `unsupported_identifier_type` rows that never
enter a denominator. Every included declaration and reference count is
unchanged.

The approved plan recompiled 1,244 target objects with
`PLSCOPE_SETTINGS='IDENTIFIERS:ALL'` and 189 dependents; the run started with
zero invalid objects and left zero invalid objects. The plan records only
`ALTER SESSION` and `ALTER … COMPILE` statements; it replaces no source.

## Result

| Section | Truth | Actual | Matched | Missing | Extra | Recall | Precision | Gate |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Declarations | 37,170 | 37,151 | 37,151 | 19 | 0 | 99.9489% | 100.0000% | PASS |
| References | 188,287 | 187,665 | 187,665 | 622 | 0 | 99.6697% | 100.0000% | **PASS** |
| Package dependencies | 5,656 | 5,553 | 5,553 | 103 | 0 | 98.1789% | 100.0000% | **FAIL** |

No reference extra of any class was emitted. Reference precision is exactly
100% on the frozen corpus: every indexed reference is a truth reference, and
the counted false positives are gone.

Truth denominators reconstruct exactly:

```text
931,686 rows
  = 37,170 included declarations
  + 188,287 included references
  + 706,229 excluded

706,229 excluded
  = 165,684 unsupported_identifier_type
  + 63,270 package_reference
  + 360,973 missing_group_declaration
  + 13,125 declaration_initializer
  + 3,548 duplicate_fact
  + 942 omitted_ambiguous_overload
  + 98,687 ephemeral_declaration
```

The run emitted 944 `ambiguous-overload` diagnostics; 942 truth `CALL` rows sit
at the exact diagnostic position and are omitted with the counted reason. Two
diagnostics describe calls that PL/Scope does not record, so they contribute no
truth row.

## What changed since 2026-10-25

| Defect | Change | Effect |
|---|---|---|
| Boolean and record-field predicate reads counted as false positives | Truth policy `v5` treats a scalar `DEFINITION` row as a reference use; Oracle documents `DEFINITION` for program units and exceptions only | 507 false positives become matched truth references |
| Qualified ambiguous calls never paired with their truth row | The `ambiguous-overload` diagnostic is emitted at the callee token instead of the first token of the statement | 942 rows omitted with a counted reason instead of 73 |
| Named associations that a candidate cannot declare were treated as positional | A named association unknown to a candidate rejects that candidate | Recovers 5 calls the wider overload wrongly made ambiguous |
| `PRAGMA EXCEPTION_INIT` arguments were skipped as non-references | The pragma's exception argument is scanned and resolved | 7 pragma references recovered |

Reference recall rose from 99.2033% to 99.6697% and precision from 99.7298% to
100%.

## Reference strata

| Stratum | Truth | Matched | Missing | Extra |
|---|---:|---:|---:|---:|
| `procedural` | 50,698 | 50,555 | 143 | 0 |
| `static_sql` | 2,201 | 2,152 | 49 | 0 |
| `member_chain` | 135,353 | 134,944 | 409 | 0 |
| `iterator` | 21 | 0 | 21 | 0 |
| `pragma` | 7 | 7 | 0 | 0 |
| `type_anchor` | 7 | 7 | 0 | 0 |

The 622 missing references fall into five classified groups:

| Group | Rows | Reason |
|---|---:|---|
| Routine call in a file with more than 20 ambiguous sites | 475 | The per-file diagnostic bound retains 20 sites; the remaining `CALL` rows stay in the denominator and count as missing, by design (391 member-chain calls, 84 unqualified calls) |
| `SELECT … INTO <record>` field writes | 49 | The target record type or `%ROWTYPE` anchor is not in the corpus, so the field write cannot be named statically |
| Member chain on a function result or collection element | 18 | 17 reads through `f(x).field` or `collection(i).field` need the callee's record type, which is unknown or `%ROWTYPE`; one is a qualified type name in a nested-routine signature |
| Routine-local declaration inside an anonymous block | 59 + 19 | PL/Scope reports the declaration's `USAGE_CONTEXT_ID` as an anonymous block, which has no identifier row, so the ephemeral rule cannot see the enclosing routine |
| Loop iterator inside a routine | 21 | Routine-local iterators are intentionally ephemeral and never published |

The first three groups are bounded by the contract's exact-position and
ambiguity rules; the last two are publication-surface or truth-normalization
limitations recorded for follow-up.

## Dependencies

The 103 missing package edges are unchanged from 2026-10-25 and are not part of
this issue. 17 edges have an authored reference in a package specification; 86
appear only in `USER_DEPENDENCIES` and have no authored reference in indexed
source. A static-only adapter cannot emit the latter without a contract policy
decision, which is the subject of
[#101](https://github.com/doberkofler/codeindex-mcp/issues/101). With 86
compiler-inferred specification edges in the denominator, 99.5% dependency
recall is not reachable by authored-source extraction.

## Replay

Preflight and replay are database-free:

```bash
pnpm build
node dist/cli.mjs oracle-preflight --bundle benchmark/oracle-production-20261026/corpus.json
node dist/cli.mjs oracle-replay --bundle benchmark/oracle-production-20261026/corpus.json
```

Replay reconstructs the live project-context layout because the generation
configuration hash includes the context name. It compares every aggregate
count, ratio, identity, and exclusion count with `qualification.json`, ignoring
only the nondeterministic `generationId` and the bounded disagreement samples.
Samples are retained in the external root but are not committed because they
contain symbol names and workspace paths.

The live requalification used:

```bash
pnpm qualify:oracle:live \
  --root "${CODEINDEX_EVIDENCE_ROOT:-$HOME/.local/share/codeindex-mcp}/oracle-live/ljs-user-source-20261025/source" \
  --output "${CODEINDEX_EVIDENCE_ROOT:-$HOME/.local/share/codeindex-mcp}/oracle-live/ljs-production-20261026" \
  --approval 97c796a2f6a3b228e8a5f34af1c0b6c3087a908deba7f2d14a513299cbdf7ce0
```

Applying a plan is DDL and requires separate explicit approval; replay and
preflight never connect to Oracle.

## Comparison with retained evidence

| Evidence | Parser | Policy | Corpus | Declarations | References | Dependencies |
|---|---|---|---|---|---:|---:|
| Phase 0 (2026-10-19) | structural | `v1` | SVN 78950, 1,237 files | 98.3956% / 99.9662% | 58.5206% / 99.4259% | 98.1734% / 100% |
| Phase 6 (2026-10-21) | `structural@5` | `v2` | SVN 78950, 1,237 files | 99.9647% / 99.9973% | 99.9278% / 100% | not published |
| Phase 8 (2026-10-20) | `structural@1` | `v2` | SVN 78950, 1,237 files | 95.5394% / 99.9711% | 57.4956% / 99.3464% | 98.1734% / 100% |
| Production 2026-10-25 | `structural@5` | `v4` | live installed, 1,244 files | 99.9462% / 100% | 99.2033% / 99.7298% | 98.1789% / 100% |
| **This run** | `structural@5` | `v5` | live installed, 1,244 files | **99.9489% / 100%** | **99.6697% / 100%** | **98.1789% / 100%** |

The 2026-10-25 bundle remains the reference point for contract `oracle-o1@2`.
Its report is not comparable with this one: the contract hash, truth policy, and
denominator differ. The document
[`documentation/oracle-qualification-contract.md`](../../documentation/oracle-qualification-contract.md)
records the change control.

## Files

- `corpus.json` — descriptor and identities.
- `corpus.sha256` — every frozen source file.
- `units.json` — path/object/source-hash mapping.
- `plscope.sha256` — external plan, run, truth exports, logs, and raw report.
- `qualification.json` — bounded aggregate report; disagreement samples are
  retained only in the external root, so the committed projection has a
  different SHA-256 from the raw report.
