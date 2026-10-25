# Exposure comparison designs

A frozen exposure design compares one artifact presented two ways by the same
client:

| Arm | Presentation |
| --- | --- |
| `direct-mcp` | The artifact's native `<server>_<tool>` names are top-level tools. |
| `code-mode` | The artifact's native catalog is callable only through the generic `execute` tool. |

Both arms use the same ordinary tools, cases, model, client runtime, tariff, and
artifact digest. The `exposure` command asserts each arm's exact agent
request-1 surface, reconciles every provider request, and records paired cost,
request/response bytes, tool-call, wall-time, and separated core-query metrics.

These records are post-certification evidence. `direct-vs-code-mode-v1.json`
compares the EVAL-037 artifact under OpenCode 2.1.4. It does not re-grade
`certification-eval-037.json`, and the frozen production exposure stays
`direct-mcp` unless the report records a new decision.

Run it from `evaluation/harness` after producing the pinned model-free route
report:

```bash
node src/cli.ts route --suite suites/release.json --treatment candidate
node src/cli.ts exposure --suite suites/exposure.json \
  --design exposures/direct-vs-code-mode-v1.json \
  --hosted-reference references/deepseek-flash-exposure-2026-10-25.json \
  --route-report <results/route/.../report.json> \
  --provider-auth-env DEEPSEEK_API_KEY
```

`--dry-run` validates every pin and prints the randomized plan.
