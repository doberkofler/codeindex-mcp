# Hosted references

A hosted reference pins the exact model identity a hosted release campaign
claims. It is independent of a local-model environment: a hosted provider exposes
no local artifact or quantization, so the provider, model ID, provider release
date, client runtime, and generation settings are pinned together and hashed into
one identity.

The harness rejects a missing field instead of defaulting it. A changed provider,
model ID, release, runtime, or generation setting produces a different reference
hash, a different campaign identity, and therefore a new paired baseline. A
historical result may never be reused as the comparison for a changed reference.

## Selected reference

`deepseek-v4-pro.json` pins `deepseek/deepseek-v4-pro`:

| Fact | Value |
| --- | --- |
| Provider | `deepseek` |
| Model ID | `deepseek-v4-pro` |
| Provider release | `2026-08-13T00:00:00.000Z` |
| Client runtime | OpenCode `2.1.2` |
| Generation settings | Provider defaults at the pinned runtime |
| Reference hash | `12ff2e9cab0cc116765bacb0a7ce46531c46eb170b35e9c539af5a55161b079f` |

The reference was selected from the hosted models available to the evaluation
machine on 2026-10-22. `deepseek/deepseek-flash` remains the recorded Q2 v4
configuration and is historical evidence only, not an automatic selection. The
Pro reference is selected for additional capability; its higher price is paid
only by a release campaign, which the local prechecks gate.

## Commands

Validate a reference and print the 270-slot release plan without starting a
model:

```bash
node evaluation/harness/src/cli.ts release \
  --suite suites/release.json \
  --hosted-reference references/deepseek-v4-pro.json \
  --target-metric retrievalBytes \
  --dry-run
```

Run the campaign only after a passing model-free route report and a passing local
regression exist for the same suite and staged artifacts:

```bash
node evaluation/harness/src/cli.ts release \
  --suite suites/release.json \
  --hosted-reference references/deepseek-v4-pro.json \
  --model-free results/route/<run>/report.json \
  --local-regression results/<local-run>/local-regression.json \
  --target-metric retrievalBytes
```

The command verifies `opencode --version` against the pinned runtime before the
first model call. It refuses a non-passing, incomplete, or artifact-mismatched
precondition. The resulting `release-campaign.json` carries
`claimClass: "hosted-model-scoped"` and `releaseAuthority: true`; local evidence
is never promoted to that class.
