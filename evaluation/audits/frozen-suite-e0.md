# Frozen release suite and calibration subset: E0 review

E0 freeze note for the `codeindex-release` suite and its `codeindex-calibration`
subset, recorded as required by
[strategy §4 E0](../../documentation/mcp-evaluation-strategy.md#e0-case-and-truth-validation)
and [G-E0a–G-E0d](../../documentation/mcp-evaluation-strategy.md#818-gate-to-check-map).

## Suite identity

| Suite | File | Version | Status | Cases | Repetitions | Treatments |
| --- | --- | ---: | --- | ---: | ---: | --- |
| `codeindex-release` | [`../suites/release.json`](../suites/release.json) | 1 | `frozen` | 18 | 5 | `no-index`, `accepted`, `candidate` |
| `codeindex-calibration` | [`../suites/calibration.json`](../suites/calibration.json) | 1 | `frozen` | 6 | 1 | `no-index`, `accepted`, `candidate`; local smoke selects `no-index` and `accepted` |

Both suites pin subject revision `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`. The
revision contains every referenced case and the controlled fixture. A changed case
content, prompt, expected set, workflow limit, or timeout changes its case hash and
is rejected; it requires a new suite version rather than an in-place edit.

## Case composition

| Class | Cases | Suite IDs |
| --- | ---: | --- |
| locate | 4 | `locate-schema-version`, `locate-read-symbol-tool`, `locate-stale-file-error`, `locate-result-size-guard` |
| impact | 6 | `impact-build-generation-references`, `impact-hash-content-references`, `impact-bounded-paged-result-references`, `impact-schema-version-references`, `impact-config-load-references`, `impact-codeindex-error-references` |
| semantic | 6 | `semantic-renamed-reexport`, `semantic-barrel-chain`, `semantic-shadowed-name`, `semantic-interface-implementations`, `semantic-type-only-import`, `semantic-default-export` |
| implementation | 2 | `impl-default-result-bytes`, `impl-empty-relative-path` |

The two repository semantic cases from the draft repository suite are retained as
additional E0 evidence but are not selected for this 18-case version. The two
repository implementation descriptors are not selected; both selected
implementation cases declare exact changed-file sets and deterministic post-run
checks.

## Semantic pattern coverage

| Required pattern | Case | Admission evidence |
| --- | --- | --- |
| Renamed re-export | `semantic-renamed-reexport` | [`semantic-e0.md`](semantic-e0.md) |
| Multi-hop barrel chain | `semantic-barrel-chain` | [`semantic-e0.md`](semantic-e0.md) |
| Shadowed common name | `semantic-shadowed-name` | [`semantic-e0.md`](semantic-e0.md) |
| Interface implementations | `semantic-interface-implementations` | [`semantic-e0.md`](semantic-e0.md) |
| Type-only import | `semantic-type-only-import` | [`semantic-e0.md`](semantic-e0.md) |
| Default-export references | `semantic-default-export` | [`semantic-e0.md`](semantic-e0.md) |

Every semantic case satisfies G-E0d: its best single-identifier literal search has
file-set precision at most 0.5 or misses an expected file. Expected sets were
verified against the TypeScript 6.0.3 language service over the reviewed fixture.

The six impact cases cover complete direct symbol consumers within `src/`. The
selected external corpus manifest records the multi-project and package-boundary
evidence; no external case is admitted to suite version 1 because exact file sets
and grep admission are not yet recorded against that checkout.

## Case hashes

| Case | SHA-256 |
| --- | --- |
| `locate-schema-version` | `c76264bf0e9a6d18f65be9592e22a6cafc850b6d420c7367cce99cc1eb0a5c7c` |
| `locate-read-symbol-tool` | `b432d24fb7f944863a53a50e53067ab7af064fd39363cad7886939f6c872b48d` |
| `locate-stale-file-error` | `cff4cb80486e806527949777bd431a411866203ad8e24e7ffad995afea864180` |
| `locate-result-size-guard` | `ade1458ec0318dcefd6e991c35dcb69602512a5f855246a00e0e21ea64253279` |
| `impact-build-generation-references` | `d64bff67a6371e942796dbec670385bade280248a4a1f6ffcbdbf08d2776053c` |
| `impact-hash-content-references` | `4a1ba04f44f7105bba70b14ad4eca346e41dea1779eaf9ca08e5bcd863ed0211` |
| `impact-bounded-paged-result-references` | `6548d0ae03406a5d20bc977d91f53524d407f087b7f1150352f25bd50d95df05` |
| `impact-schema-version-references` | `e298f45bb6b51d554d15c84e550c1adf6e3e2c356d8b7a9c774e8f1da9a52505` |
| `impact-config-load-references` | `c76024549fc8c2c77f41b1acc66b70a5886f893b0f33ce294e27a63929daf7a5` |
| `impact-codeindex-error-references` | `6daca9f9b73d09a986d4e7ecf7567b4deee714fadf9e66b07cedac493e80ad26` |
| `semantic-renamed-reexport` | `b500a59ec735fd6a97d763726cf5a482cdc019233eb81ccbd91d749f1139caf8` |
| `semantic-barrel-chain` | `9af69070bdd65174174bfb137386f682a382f648ef90bf9f0556efd26c070384` |
| `semantic-shadowed-name` | `9178655ac7f9453bff50585853818499867bcacd886a8f9954ce6235b50ef72f` |
| `semantic-interface-implementations` | `4d01ffd36a2f2751071bc2e3b787793a7c133aa5c3832a95cf4248542b2b80fe` |
| `semantic-type-only-import` | `37727bbccaaea64052b41c497a1a61f68a7c86c9d4adf86ad3890f0b7b5a5e50` |
| `semantic-default-export` | `9776c377f6068bc68c38e1afbdc90c3f7c0e2b8ad2e9ac9ec9f5143f4e9799f3` |
| `impl-default-result-bytes` | `1aead68f05c4fa31be51a6198a589162168d98bcb341ba5aeb2928cca49be5f0` |
| `impl-empty-relative-path` | `be517d40d2ec04b2998b1524c26134f8cdaed9bca408bfca9180d1176a7d2fb3` |

## Calibration subset

The six-case subset is one locate, two impact, two semantic, and one implementation
case. It mirrors the release class proportions at half scale and keeps the two most
expensive classes bounded:

| Case | Class | Rationale |
| --- | --- | --- |
| `locate-schema-version` | locate | Single authoritative declaration and a small expected set |
| `impact-build-generation-references` | impact | Two-consumer complete set |
| `impact-schema-version-references` | impact | Four-consumer storage and transport set |
| `semantic-renamed-reexport` | semantic | Symbol identity through a renamed alias |
| `semantic-interface-implementations` | semantic | Implementation lookup with two implementers |
| `impl-default-result-bytes` | implementation | Bounded edit with a deterministic unit-test check |

The local smoke command runs 6 cases × 2 treatments × 1 repetition = 12 executions:

```bash
node evaluation/harness/src/cli.ts evaluate --suite suites/calibration.json \
  --treatment no-index,accepted --repetitions 1
```

The manifest declares the 8B smoke model. The 27B/35B calibration tasks select
and pin their own model identity and generation settings before execution; a
changed model identity creates a new comparison.

## Corpus manifests

- CodeIndex repository snapshot: this repository at
  `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`, using `tsconfig.json`.
- Controlled TypeScript fixture:
  [`../fixtures/controlled-typescript`](../fixtures/controlled-typescript/README.md)
  at the same revision, using its own `tsconfig.json`. Truth authority is the
  TypeScript 6.0.3 language service.
- External repository: [`../corpora/external-material-ui.json`](../corpora/external-material-ui.json)
  pins Material UI at `28eadba9ec2899226ecbf4058b8fba1ddeab9e6d`. It supplies
  package-boundary evidence for a later suite version; its `caseHashes` remains
  empty because no case is admitted to this suite version.

## Expected runtime

Estimates use the Q2 v4 indexed p95 wall time of 13.8 s plus the harness's 5 s
pacing between executions, rounded to 20 s per execution:

| Campaign | Executions | Expected runtime | Hard bound |
| --- | ---: | ---: | ---: |
| Calibration smoke (`no-index`, `accepted`) | 12 | about 4 minutes | 36 minutes |
| Local regression (3 treatments × 3 repetitions) | 162 | about 55 minutes | 8.1 hours |
| Hosted release (3 treatments × 5 repetitions) | 270 | about 90 minutes | 13.5 hours |

The calibration budget is 15 minutes per local model. The expected 4-minute run
leaves room for model load and per-case variance; the hard bound is the worst case
when every execution reaches its 180 s timeout.

## Validation

The suites are validated by the harness schema, the frozen case-hash check, the
TypeScript language-service case tests, and the calibration plan test:

```bash
node evaluation/harness/src/cli.ts list --suite suites/release.json
node evaluation/harness/src/cli.ts evaluate --suite suites/release.json --dry-run
node evaluation/harness/src/cli.ts list --suite suites/calibration.json
node evaluation/harness/src/cli.ts evaluate --suite suites/calibration.json --dry-run \
  --treatment no-index,accepted --repetitions 1
pnpm eval:verify
pnpm test
```

`--dry-run` verifies case hashes, treatment equivalence, and the ordered plan
without starting a model or MCP process. It requires the subject checkout to be
clean and at the pinned revision; run it in a detached worktree at that revision
when the suite worktree carries later commits.

The release suite validates as 18 cases with class counts 4/6/6/2 and six admitted
semantic cases. The calibration suite validates as a six-case subset with class
counts 1/2/2/1 and a 12-execution dry-run plan.
