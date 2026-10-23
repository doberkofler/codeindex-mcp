# Agent request-1 surface evidence

Date: 2026-10-23

Scope: implementation evidence for [EVAL-032 (#60)](https://github.com/doberkofler/codeindex-mcp/issues/60).
This is model-free treatment-integrity evidence. It does not re-grade E3, run a
hosted campaign, or support an economic claim.

## What was built

`evaluation/harness/src/opencodeServer.ts` starts a private OpenCode server,
requires `/api/mcp` to report every expected MCP server `connected`, and only
then allows a `run --server` process to admit the prompt. Registration, process
startup, and a `pending` status are not readiness. A failed connection is polled
through the bound so a reconnect can recover.

`evaluation/harness/src/requestSurface.ts` reduces every provider request to its
ordinal, closed kind, and offered tool names. It asserts the first agent request
against the exact declared surface and returns a closed cause:

| Cause | Meaning |
| --- | --- |
| `mcp-not-ready` | The OpenCode server never reported the configured server connected. |
| `probe-failed` | The cold-start process or provider probe failed before a verdict. |
| `no-agent-request` | No agent request was admitted. |
| `empty-agent-request` | Agent request 1 offered no tools. |
| `duplicate-tools` | Agent request 1 repeated a tool name. |
| `late-surface` | A declared tool first appeared after agent request 1. |
| `incomplete-surface` | A declared tool never appeared on request 1. |
| `unknown-tools` | Agent request 1 offered an undeclared tool. |
| `codeindex-in-no-index` | The no-index treatment offered a `codeindex_*` tool. |

`evaluation/harness/src/mcpReadiness.ts` separately verifies the exact configured
artifact command with a real `initialize`/`tools/list` handshake and the declared
native catalog before the cold starts. `evaluation/harness/src/surfaceProbe.ts`
answers only the first agent request, so a later turn cannot repair request 1.

Every treatment must survive twenty consecutive cold starts before the first
hosted-model request. Evidence is written under
`results/<campaign>/surface/<treatment>/` as `readiness.json` and
`cold-start-NN.json`; a failure is written as `surface-proof-failure` with its
closed cause. The evidence contains no prompts, source text, credentials, or
provider envelopes.

## Cold-start result

Loopback provider, OpenCode 2.1.3, the staged `accepted` artifact, and the frozen
no-index treatment were exercised twenty consecutive times each. Every run was a
fresh OpenCode server and provider probe.

| Treatment | Cold starts | Request-1 result | Observed request-1 tools |
| --- | ---: | --- | --- |
| `accepted` | 20/20 | exact declared surface | `codeindex_find_dependencies`, `codeindex_find_references`, `codeindex_find_symbol`, `codeindex_index_status`, `codeindex_outline`, `codeindex_read_symbol`, `codeindex_symbol_at`, `glob`, `grep`, `read`, `shell` |
| `no-index` | 20/20 | exact ordinary-only surface | `glob`, `grep`, `read`, `shell` |

The indexed server reported `connected` on readiness attempt 5 in every accepted
cold start; the no-index server needed one status read and configured no MCP
server. No accepted run first exposed a CodeIndex tool on request 2, and no
no-index request exposed one at all.

Before the readiness gate, the same workspace produced agent request 1 with only
`glob`, `grep`, `read`, and `shell`; MCP tools were absent because the prompt was
composed while the server was still starting. That is the E3 failure mode this
change rejects.

## Deterministic tests

- `requestSurface.test.ts` covers exact indexed and no-index request 1, late
  tools, duplicate names, unknown tools, empty/no agent requests, and the thrown
  closed cause.
- `surfaceProbe.test.ts` covers title/agent separation, a missing CodeIndex tool
  on request 1, a no-index CodeIndex tool, a probe with no agent request, and
  twenty consecutive cold starts per treatment through the loopback provider.
- `mcpReadiness.test.ts` covers delayed registration, reconnect after a
  transient launch failure, persistent server failure, initialize timeout,
  invalid/empty/duplicate catalogs, and catalog mismatch.
- `opencodeServer.test.ts` covers pending-to-connected registration, reconnect
  after `failed`, a never-reconnecting server, an expected server that never
  appears, startup timeout, and early server exit.

## Claim boundary

The proof establishes that a correctly configured treatment can expose the exact
declared surface on agent request 1, and that an incomplete surface stops the
campaign before hosted-model spend. It does not establish corpus coverage,
workspace isolation, statistical validity, or a cost effect. Those remain with
#61–#65. No value in this evidence is an invoice-time cost or an efficacy claim.
