# Local-model environments

A file in this directory pins every fact needed to reproduce one local-model
execution: host, Node, OpenCode, Ollama, provider model digest, quantization,
context, generation settings, and the reference-machine label. The harness
rejects a manifest that omits any of them; a missing fact is never defaulted.

A manifest declares one `purpose`:

- `smoke` pins an accepted-only harness check. `ollama-qwen3-8b-smoke.json` is the
  declared smoke environment. It runs the frozen six-case calibration subset with
  the accepted treatment only. The 8B model checks the environment and harness
  path; it makes no quality claim and is not a regression sentinel.
- `calibration` pins a model entering the independent `qualification` campaign.
  `ollama-qwen3.8-27b-calibration.json` and
  `ollama-qwen3.6-35b-calibration.json` are the EVAL-022 candidates;
  `ollama-devstral-small-2-calibration.json` is the EVAL-026 candidate. A
  calibrated reference is cited by the audit record, not by renaming or
  duplicating a manifest. A changed host, runtime, digest, quantization, context,
  or generation setting requires a new capture and starts a new baseline.
- `ollama/devstral-small-2` is installed locally as the `:latest` tag. Its
  identity is pinned by the digest `24277f07f62db8f9cb68e9dfc679ea1818a7fbac47a50eff0a701d3f645b63c8`,
  which reports `24.0B` parameters and `Q4_K_M` quantization; the tag name is not
  the identity.

## Commands

Capture the measured host and model into a new manifest:

```bash
node evaluation/harness/src/cli.ts environment --capture \
  --model ollama/qwen3:8b \
  --id ollama-qwen3-8b-smoke \
  --reference-machine apple-m5-max-64gb \
  --output environments/ollama-qwen3-8b-smoke.json
```

Verify that the current machine still matches the pin:

```bash
node evaluation/harness/src/cli.ts environment --check \
  --environment environments/ollama-qwen3-8b-smoke.json
```

Run the accepted-only smoke. The command verifies the live environment first,
then executes six cases once each through isolated `--standalone` OpenCode
processes:

```bash
node evaluation/harness/src/cli.ts smoke \
  --suite suites/calibration.json \
  --environment environments/ollama-qwen3-8b-smoke.json
```

`--dry-run` validates the suite, environment model, and plan without measuring
the host or starting a model. Generated results stay under `results/`, which is
never committed. A changed model digest, quantization, runtime version, context,
generation setting, or host fact requires a new manifest and a new smoke
baseline.

Calibrate one or more candidates against the same frozen six-case subset:

```bash
node evaluation/harness/src/cli.ts calibrate \
  --suite suites/calibration.json \
  --environment environments/ollama-qwen3.8-27b-calibration.json \
  --environment environments/ollama-devstral-small-2-calibration.json \
  --exclude "ollama-devstral-small-2-calibration=<operator reason>" \
  --budget-ms 900000
```

The command verifies every eligible pinned environment, then runs the diagnostic
phase and six cases × `no-index` and `accepted` × one repetition per model. It
stops a model at its wall-clock budget, writes `calibration.json` beside that
model's results, and writes one `selection.json` naming the predeclared winner.
`--exclude` records a candidate ruled out before execution as a disqualification
with zero executions; it is an operator constraint, not a model-quality result.
A model qualifies only when all 12 executions are valid, no case loses accepted
correctness against `no-index`, no execution needs an intervention, and the
budget is met. A changed model artifact or environment fact changes the
environment hash, campaign identity, and therefore the baseline.
