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

`deepseek-flash.json` pins `deepseek/deepseek-flash`:

| Fact | Value |
| --- | --- |
| Provider | `deepseek` |
| Model ID | `deepseek-flash` |
| Provider release | `2026-10-17T00:00:00.000Z` |
| Client runtime | OpenCode `2.1.2` |
| Generation settings | Provider defaults at the pinned runtime |
| Reference hash | `e3d86f8914fe9b9d77e9048216acd1535a44cf98b7e69a35edb3a1cf19dae07e` |

The reference was selected from the hosted models available to the evaluation
machine on 2026-10-23. Earlier Q2 v4 evidence used the same model ID under an
older campaign identity and remains historical only. The new frontier campaign
runs every treatment from scratch; it does not reuse those executions.
Deterministic model-free evidence gates the hosted spend; independent local-model
qualification does not.

`deepseek-v4-pro.json` is retained only to identify the unexecuted historical E2
dry-run record. It is not the selected reference for #36.

## Commands

Validate a reference and print the 270-slot release plan without starting a
model:

```bash
node evaluation/harness/src/cli.ts release \
  --suite suites/release.json \
  --hosted-reference references/deepseek-flash.json \
  --target-metric retrievalBytes \
  --dry-run
```

Run the campaign from scratch after a passing model-free route report exists for
the same suite, revision, and staged artifacts:

```bash
node evaluation/harness/src/cli.ts release \
  --suite suites/release.json \
  --hosted-reference references/deepseek-flash.json \
  --model-free results/route/<run>/report.json \
  --target-metric retrievalBytes
```

The command does not read local qualification. A failed, blocked, or absent local
record neither authorizes nor blocks the hosted plan, and the historical
`--local-regression` argument is no longer part of the interface.

The command verifies `opencode --version` against the pinned runtime before the
first model call. It refuses missing, non-passing, stale, incomplete, or
artifact-mismatched model-free evidence. The resulting `release-campaign.json`
carries `claimClass: "hosted-model-scoped"` and `releaseAuthority: true`; local
evidence is never promoted to that class.
