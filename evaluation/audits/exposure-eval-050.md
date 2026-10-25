# Paired direct-MCP/Code-Mode exposure comparison: PROD-004 evidence

Date: 2026-10-25

Scope: post-certification evidence for
[PROD-004 (#50)](https://github.com/doberkofler/codeindex-mcp/issues/50). It
compares the frozen EVAL-037 artifact under two client exposures. It does not
change, re-grade, or enlarge [EVAL-037](certification-eval-037.md), and it makes
no release-authority claim.

## Frozen design

The design was digested before the first provider request as
[`../exposures/direct-vs-code-mode-v1.json`](../exposures/direct-vs-code-mode-v1.json),
digest `eb70afcc07b37e0a981416499f8893c0c1b6c4b4736684985b2c7035231714d7`.

| Fact | Frozen value |
| --- | --- |
| Contract | `evaluation-validity-v2`, digest `179bb5df1bc96ee86c54da20f26034a59fe50671dfc9912d805ed4588204a22f` |
| Suite | `codeindex-exposure` v1, hash `e3f2e0814d2e791c29890b27517b6d0fda5d3a670ccc93a734982d02cdd64452` |
| Cases | Six frozen impact-class cases from `codeindex-release` v1 |
| Repetitions | 5 paired repetitions per case = 60 executions |
| Treatments | `direct-mcp` and `code-mode`, same artifact |
| Artifact | `codeindex-mcp-candidate@ac846e44cf7c527f9d361ff7ca266e5e2bbdae4d2dd80f9c1e111ac124d4e205` |
| Ordinary tools | `bash`, `glob`, `grep`, `list`, `read` |
| Model | `deepseek/deepseek-flash`, DeepSeek-V4.1-Flash-1017, OpenCode 2.1.4 |
| Tariff | `deepseek-flash-2026-10-23`, digest `593634d1954e4ccd8303d71b68db15ba6f266e154a5f7f2e3da1f9db0fd16712` |
| Core-query route | `codeindex-release` model-free plan, hash `96dee1cb3fd17fcfa66ec0ac6917bffda737119fe019f10570bd66f6c85547e4` |
| Budget | 60 executions, 10,800,000 ms wall clock, 1 USD provider spend |
| Decision threshold | Adopt Code Mode only when its upper one-sided 95% cost ratio is below 0.95 with non-inferior correctness |

Only the OpenCode MCP presentation changes. `direct-mcp` presents the native
`codeindex_*` tools top-level; `code-mode` presents the generic `execute` tool
and reaches the same native catalog through it.

## Command

```bash
EVALUATION_STATE_ROOT=<external-root> DEEPSEEK_API_KEY=<key> \
  node evaluation/harness/src/cli.ts exposure \
  --suite suites/exposure.json \
  --design exposures/direct-vs-code-mode-v1.json \
  --hosted-reference references/deepseek-flash-exposure-2026-10-25.json \
  --route-report <results/route/.../report.json> \
  --provider-auth-env DEEPSEEK_API_KEY
```

The core-query route report was produced by:

```bash
node evaluation/harness/src/cli.ts route --suite suites/release.json --treatment candidate
```

## Request-1 surfaces

Each arm passed 20 consecutive cold starts before any hosted request:

| Arm | Exact request-1 tools |
| --- | --- |
| `direct-mcp` | `codeindex_find_dependencies`, `codeindex_find_references`, `codeindex_find_symbol`, `codeindex_index_status`, `codeindex_outline`, `codeindex_read_symbol`, `codeindex_symbol_at`, `glob`, `grep`, `read`, `shell` |
| `code-mode` | `execute`, `glob`, `grep`, `read`, `shell` |

Every final execution also passed its own agent request-1 assertion: 30/30 for
each arm. A native tool presented top-level in the Code Mode arm would have
failed the proof before spend.

## Validity and recovery

The first execution pass stored 60/60 slots but 14 were invalid: upstream
requests failed or stalled at the provider boundary, and several executions
timed out. The harness recorded the blocked comparison and no recommendation.
The invalid slots were re-executed with `--resume`; valid slots were reused
because their complete identity matched. The final record contains:

| Fact | Observed |
| --- | --- |
| Stored / planned | 60 / 60 |
| Valid / exact-metered | 60 / 60 |
| Invalid | 0 |
| Path-clean | yes |
| Timed out | 0 |
| Retried slots | 31 |
| Failed attempts retained | 72 |

Every retained provider request settled exactly once with complete usage. No
failed attempt was discarded from the run record.

## Result

The sanitized record is
[`../reports/exposure-eval-050.json`](../reports/exposure-eval-050.json).
Campaign: `codeindex-exposure-f132f7921764a511`.

| Metric | Direct MCP | Code Mode | Ratio | Paired 95% ratio interval |
| --- | ---: | ---: | ---: | --- |
| Total task cost (USD) | 0.000667 | 0.000872 | **1.307** | 1.126 – 1.507 |
| Provider request bytes | 228,639 | 258,737 | **1.132** | 0.983 – 1.289 |
| Provider response bytes | 88,390 | 133,991 | **1.516** | 1.255 – 1.759 |
| Tool calls | 2.57 | 2.63 | **1.026** | 0.890 – 1.176 |
| Wall time (ms) | 9,446 | 10,312 | **1.092** | 0.989 – 1.177 |
| Core query time (ms) | 6.17 | 6.17 | **1.000** | exposure-invariant |

Core query time is the artifact's reported handler duration from the pinned
model-free route report (5–8 ms per case). It is separated from provider cost,
serialization, and the Code Mode wrapper.

Correctness was non-inferior: direct succeeded on 29/30 executions and Code
Mode on 30/30, a paired degradation of `-0.0333` with a one-sided upper bound of
`0.0000` against the frozen `0.02` margin. There were no false absences.

## Exposure decision

**Retain the frozen `direct-mcp` production exposure under the pinned
conditions.** Code Mode's upper one-sided 95% cost ratio is `1.473`, far above
the predeclared `0.95` adoption threshold. Its measured central estimate is
30.7% more expensive, 51.6% more provider response bytes, 13.2% more request
bytes, 2.6% more tool calls, and 9.2% slower in wall time. Core query time is
unchanged, so the difference is exposure overhead rather than artifact query
cost.

This confirms the EVAL-037 exposure selection; it does not reopen it. The result
does not change `certification-eval-037.json`.

## Limitations

- The claim is scoped to the exact model, client runtime, artifact, six fixed
  cases, ordinary tools, tariff, and exposure definitions pinned by the design.
- Five paired repetitions per case support the exposure decision, not a
  cost-equivalence claim about unrelated tasks or models.
- Provider cost is static-tariff arithmetic over retained components, not
  invoice-time cost.
- Core query time is measured model-free; it is not the model's full task time.
- The first pass retained provider-boundary failures and timeouts. They are
  retained in the run evidence; only the resumed final slots are summarized in
  the sanitized report.

## Claim boundary

Permitted: repeat the frozen comparison, cite the measured direct-versus-Code-
Mode overhead for this artifact and pinned client, and note that native direct
MCP remains recommended.

Not permitted: claim Code Mode is generally slower or faster, change EVAL-037,
enlarge the release population, or infer exposure overhead for another model,
client version, artifact, task set, or ordinary tool set.
