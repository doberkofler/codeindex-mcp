# Local-model environments

A file in this directory pins every fact needed to reproduce one local-model
execution: host, Node, OpenCode, Ollama, provider model digest, quantization,
context, generation settings, and the reference-machine label. The harness
rejects a manifest that omits any of them; a missing fact is never defaulted.

`ollama-qwen3-8b-smoke.json` is the declared smoke environment. It runs the
frozen six-case calibration subset with the accepted treatment only. The 8B
model checks the environment and harness path; it makes no quality claim and is
not a regression sentinel.

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
