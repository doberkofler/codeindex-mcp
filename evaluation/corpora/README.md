# Evaluation corpus manifests

One manifest per selected corpus records the identity a campaign must pin. The
[harness contract](../../documentation/evaluation-harness.md#3-cases-suites-and-treatments)
defines its use; the selected external corpus is
[`external-material-ui.json`](./external-material-ui.json).

A corpus manifest is not a suite. It names the repository, revision, project
file, lock hash, preparation steps, truth authority, and known limitations. Suites
reference the cases; the manifest proves which source they were reviewed against.

## Selected external corpus

`external-material-ui` supplies TSX, JavaScript, renamed re-exports, barrel
chains, default exports, and package-boundary evidence that the controlled
fixture and the CodeIndex repository snapshot do not.

## Rules

- Checkouts, installed dependencies, and databases stay outside the repository.
- A manifest never contains an absolute path; the checkout root is supplied by
  configuration when a campaign runs.
- The revision and lock hash must match the prepared checkout before a campaign
  uses it.
- `caseHashes` stays empty until a suite freeze admits cases against this corpus.
  Release suite version 1 admits no external case, so the selected manifest keeps
  an empty hash set.
- Source is read-only. Preparation may install dependencies with lifecycle scripts
  disabled and may clean untracked generated files, but a run never edits source.
