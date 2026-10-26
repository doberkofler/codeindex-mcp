# Oracle O1 Qualification Contract

**Contract:** `oracle-o1`
**Version:** `3`
**Contract hash:** `ead99963af1b78ca968256e66a0a5bd01cd4e80d3e781fbe0b50e8d1749357d7`
**Truth policy:** `v5`
**Status:** authoritative. This document and
[`oracleQualificationContract.ts`](../src/core/qualification/oracle/oracleQualificationContract.ts)
are the single release contract for Oracle O1 semantic production readiness.

Date: 2026-10-26

## 1. Purpose

The adapter had two descriptions of the same release gate. The executable
qualification used truth policy `v2` and measured every PL/Scope row it could
map. The retained Phase 6 publication evidence used policy `v2` plus an
additional, external rule: a `CALL` row whose site the adapter classifies as
`ambiguous-overload` was removed from the truth denominator after
qualification. `qualify:oracle` could therefore not reproduce the published
population.

Contract `oracle-o1@2` removed that split. It also aligned truth with the
publication surface: parameters and routine-local declarations are intentionally
ephemeral and never persisted, so they are omitted with the counted reason
`ephemeral_declaration` instead of being counted as recall failures. Truth
normalization, every exclusion reason, ambiguity handling, and every threshold
are one executable object. `qualify:oracle` runs it directly and produces every
denominator in its report. No post-processing step is part of the gate.

Contract `oracle-o1@3` corrects the `DEFINITION` usage mapping that `v2`
widened to every supported identifier type. Oracle documents `DEFINITION` for
exceptions and program units only: "a `DEFINITION` tells the compiler how to
implement or use a previously declared identifier", and "for a top-level
identifier only, the `DEFINITION` and `DECLARATION` are in the same place"
(Oracle Database *Using PL/Scope*, identifier usages). Oracle 19c nevertheless
reports a bare Boolean predicate read (`IF flag THEN`) as a `DEFINITION` of the
scalar. Under `v4` each such row became an invented declaration at the read
site, was dropped as ephemeral, and left the adapter's legitimate reference at
the same position counted as a false positive. Policy `v5` keeps the documented
declaration meaning for program units and treats every scalar `DEFINITION` row
as a reference use. `@3` also aligns the emitted `ambiguous-overload`
diagnostic with the callee token, which is the position PL/Scope reports for the
`CALL` row the rule is meant to pair.

Agent usefulness and hosted-model cost are outside this contract.

## 2. Authority and replay-only policies

| Policy / contract | Status | Use |
|---|---|---|
| `oracle-o1@3` with truth policy `v5` | **authoritative** | Every current production qualification |
| `oracle-o1@2` with truth policy `v4` | historical | Retained 2026-10-25 production and controlled evidence |
| truth policy `v3` | replay only | Contract `oracle-o1@1` evidence |
| truth policy `v2` | replay only | Phase 8 evidence and historical comparisons |
| truth policy `v1` | replay only | Phase 0 evidence and historical comparisons |

`qualify:oracle` selects `v5` unless `--truth-policy` names a historical
policy. A historical policy can never satisfy the release gate on its own: it is
not the contract, and its result is evidence about a past comparison. Evidence
produced under a superseded contract is retained as historical; its run record
no longer matches the authoritative contract identity, so preflight rejects it
and it cannot be replayed as current evidence.

## 3. Truth population

### 3.1 Object types

PL/Scope rows are considered only for objects that O1 can map to authored
source:

| PL/Scope object type | Source extension |
|---|---|
| `PACKAGE` | `.pks`, `.pkg` |
| `PACKAGE BODY` | `.pkb` |
| `FUNCTION` | `.fnc` |
| `PROCEDURE` | `.prc` |

Rows for any other object type are counted as `outOfScopeObjectRows` and never
enter a denominator. Rows shorter than the ten required columns are counted as
`malformedRows` and also never enter a denominator.

Every remaining row is a **mapped row** and enters `truth.rows`. A mapped row is
either included in truth or omitted with exactly one reason from section 4.
Rows for objects absent from the indexed corpus abort the run
(`unmappedObject: abort`); they never shrink truth.

### 3.2 Supported identifier types

| PL/Scope identifier type | O1 symbol kind |
|---|---|
| `PACKAGE` | `package` |
| `FUNCTION` | `function` |
| `PROCEDURE` | `procedure` |
| `FORMAL IN`, `FORMAL OUT`, `FORMAL IN OUT` | `parameter` |
| `VARIABLE` | `variable` |
| `CONSTANT` | `constant` |
| `CURSOR` | `cursor` |
| `RECORD` | `record_type` |
| `RECORD FIELD` | `field` |
| `SUBTYPE` | `subtype` |
| `EXCEPTION` | `exception` |
| `REFCURSOR` | `ref_cursor_type` |
| `INDEX TABLE`, `ASSOCIATIVE ARRAY`, `NESTED TABLE`, `VARRAY` | `collection_type` |
| `ITERATOR`, `RECORD ITERATOR` | `variable` |

The same map filters indexed occurrences. An indexed kind outside the mapped
kinds is not scored.

### 3.3 Usage mapping

| PL/Scope usage | Role |
|---|---|
| `DECLARATION` | declaration |
| `DEFINITION` of a program-unit type (`PACKAGE`, `FUNCTION`, `PROCEDURE`) or `EXCEPTION` | declaration |
| `DEFINITION` of any other supported identifier type | reference |
| `REFERENCE` | reference |
| `ASSIGNMENT` | reference |
| `CALL` | reference |
| anything else | omitted as `unmapped_usage` |

A reference at the exact key of an included declaration in the same signature
group is omitted as `declaration_initializer`; it is the declaration's
initializer, not a use. A signature group is the PL/Scope `SIGNATURE`. A group
with no included declaration cannot anchor a reference; each such reference is
omitted as `missing_group_declaration`.

`DEFINITION` is documented for exceptions and program units, where it is the
point at which the declared identifier is implemented. A scalar identifier has
no `DEFINITION`; Oracle 19c reports one only for a bare Boolean predicate read,
which is a use of the already-declared identifier. Policy `v5` therefore maps a
scalar `DEFINITION` row to a reference instead of inventing a declaration at
the read site.

### 3.4 Package and body mapping

`PACKAGE` and `PACKAGE BODY` are separate truth objects mapped to separate
authored files. Package-qualifier references are owned by dependency edges, not
by symbol occurrences, so a reference whose PL/Scope identifier type is
`PACKAGE` is omitted as `package_reference`.

## 4. Exclusion reasons

Every omitted mapped row carries one stable reason and its authored position.
Counts are reported per reason.

| Reason | Meaning |
|---|---|
| `unsupported_identifier_type` | Declaration or reference whose PL/Scope type is outside section 3.2 |
| `unmapped_usage` | Usage outside section 3.3 |
| `invalid_declaration` | Supported declaration whose mapped authored token does not contain the declared name |
| `package_reference` | Package-qualifier reference owned by a dependency edge |
| `missing_group_declaration` | Reference whose signature group has no included declaration |
| `declaration_initializer` | PL/Scope reference at the exact key of an included declaration in the same signature group |
| `duplicate_fact` | Repeated identical key in one signature group; the first row is kept |
| `omitted_ambiguous_overload` | `CALL` row at the exact position of an emitted `ambiguous-overload` diagnostic |
| `ephemeral_declaration` | Parameter or routine-local declaration that the publication surface intentionally never stores |

The reason list is frozen in the code and the contract identity. Adding,
removing, or reinterpreting a reason requires a contract version bump.

## 5. Ambiguity policy

The adapter emits one bounded diagnostic with code `9105`
(`ambiguous-overload`) when an unqualified or package-qualified call has more
than one fitting overload, and it emits no occurrence for that site. The
diagnostic is positioned at the callee token, which is the location PL/Scope
reports for the `CALL` row. Under the authoritative policy a `CALL` truth row
at the **exact** `path`, `line`, and `column` of one such diagnostic is omitted
as `omitted_ambiguous_overload`.

Adapter diagnostics are bounded per file; overflow retains one synthetic
diagnostic instead of individual sites. A truth row whose ambiguity diagnostic
was not retained stays in the denominator and counts as missing, so the bound
lowers recall rather than silently enlarging the omission.

The rule is deliberately narrow:

- only status `CALL` with a supported identifier type;
- only the exact authored diagnostic position, with no line or column
  tolerance;
- only when the truth policy is the contract policy;
- every other PL/Scope row stays in the denominator;
- no emitted occurrence is exempted from precision.

The report records both the number of ambiguity diagnostic sites
(`truth.ambiguousOverloadDiagnostics`) and the number of truth rows omitted by
the rule (`truth.excludedByReason.omitted_ambiguous_overload`). They are not
required to be equal: a diagnostic may describe a call that PL/Scope does not
record, and that call then contributes no truth row.

Retained Phase 6 evidence performed this removal outside the gate and reported
1,420 omitted rows out of 188,297 raw CALL rows. Contract `oracle-o1@2` made
the same rule executable and auditable; `@3` positions each diagnostic at the
callee token so a qualified call pairs with its PL/Scope `CALL` row instead of
the statement's first token. The historical artifact is not rewritten and
remains historical evidence.

## 6. Gates

| Section | Recall | Precision |
|---|---:|---:|
| Declarations | ≥ 99.5% | exactly 100% |
| References | ≥ 99.5% | exactly 100% |
| Package dependencies | ≥ 99.5% | exactly 100% |

Empty truth fails every gate. A run whose export contains no mapped row or whose
gates fail exits `1`; it must not be recorded as a pass.

No threshold may be relaxed to preserve an earlier result. A gate change is a
contract change.

### 6.1 Denominator reconstruction

The report contains every number needed to rebuild the comparison:

```text
truth.rows
  = truth.includedDeclarations
  + truth.includedReferences
  + truth.excludedTotal

truth.excludedTotal
  = sum(truth.excludedByReason[reason])

recall    = matched / truth.<section>.truth
precision = matched / (actual - ignoredExtra)
```

`ignoredExtra` is the sum of `omitted_by_policy`, `location_mismatch`, and
`outside_plscope` extras. Only `false_positive` extras count against precision.
Disagreement samples are bounded by `contract.sampleLimit` (20) per comparison.

## 7. Report identity

Every report and every live `run.json` records:

| Field | Meaning |
|---|---|
| `contract.id`, `contract.version`, `contract.hash` | Contract identity |
| `contract.truthPolicy` | Executed truth policy |
| `contract.thresholds` | Exact gate values |
| `contract.emptyTruth` | `fail` |
| `contract.sampleLimit` | Retained sample bound |
| `contract.objectTypes` | Truth object population |
| `contract.exclusionReasons` | Frozen reason list |
| `contract.ambiguity` | Diagnostic code, usage, and position match |
| `parser.id`, `parser.revision`, `parser.compilerVersion` | Parser identity |
| `corpus.files`, `corpus.objects` | Corpus cardinality |
| `corpus.sourceHash`, `corpus.configHash` | Indexed source and configuration identity |
| `truth.identifiersSha256`, `truth.dependenciesSha256` | Truth export identity |
| `generationId` | Published generation used for the comparison |

A report whose `contract.hash` differs from this document belongs to a different
contract and cannot be compared with this evidence. A report whose
`policy.version` differs from `contract.truthPolicy` is an explicit historical
replay, not a contract run.

## 8. Execution

Verify the evidence bundle before any replay; preflight is DB-free and fails
before a DDL-capable session can be opened:

```bash
pnpm build
node dist/cli.mjs oracle-preflight --bundle benchmark/oracle-production-20261026/corpus.json
node dist/cli.mjs oracle-replay --bundle benchmark/oracle-production-20261026/corpus.json
```

`oracle-replay` is also DB-free. It replays the retained snapshot and truth in a
temporary SQLite database and compares the report with the committed
`qualification.json`; only the nondeterministic `generationId` and the
uncommitted disagreement samples are ignored.

Then build and run the gate:

```bash
pnpm build
node dist/cli.mjs qualify --extractor oracle \
  --root <workspace> \
  --project-file <workspace>/oracle-index.json \
  --identifiers <evidence>/user-identifiers.csv \
  --dependencies <evidence>/user-dependencies.csv \
  --units <evidence>/plan.json \
  --output /tmp/oracle-qualification.json
```

`pnpm qualify:oracle` and `pnpm qualify:oracle:live` use the same contract. Live
qualification additionally requires an approved plan; it performs no DDL before
approval and records the contract and truth counts in `run.json`.

To replay historical evidence, name its policy explicitly:

```bash
--truth-policy v1   # Phase 0
--truth-policy v2   # Phase 8
--truth-policy v3   # Contract oracle-o1@1
--truth-policy v4   # Contract oracle-o1@2 evidence
```

## 9. Verification

The contract is tested by `test/oracleQualificationContract.test.ts`:

- the pinned identity and hash;
- inclusion of every supported identifier type;
- exclusion of every unsupported class;
- every usage mapping, including a scalar `DEFINITION` row and a program-unit
  `DEFINITION` row;
- every exclusion reason with counted rows;
- exact ambiguity scoping;
- denominator reconstruction;
- a red case for every gate and for empty truth.

`test/oracleQualificationRun.test.ts` proves that the executable report carries
the contract, parser identity, corpus identity, truth hashes, and exclusion
counts. `test/oracleCodeFacts.test.ts` proves the ambiguity sites are read from
the published generation and filtered to the contract diagnostic code.
`test/oracleResolveCandidates.test.ts` proves the ambiguity diagnostic is
positioned at the callee token and that a named association the candidate cannot
declare rejects that candidate. `test/oraclePublicationSurface.test.ts` proves a
`PRAGMA EXCEPTION_INIT` argument is a reference while other pragma arguments are
not.

## 10. Change control

Any semantic change to this contract requires, in one change:

1. a contract version bump and a regenerated `contract.hash`;
2. the pinned hash in `test/oracleQualificationContract.test.ts`;
3. this document and the adapter documentation;
4. new qualification evidence produced by the bumped contract;
5. retention of the previous evidence as historical, never overwritten.

Configuration changes, parser changes, corpus changes, truth-export changes, or
threshold changes are semantic changes.
