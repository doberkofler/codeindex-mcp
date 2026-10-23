# Completed local regression: E4 record

Historical record for the completed v1 three-treatment local regression. This
campaign was executed under the policy that preceded the 2026-10-23 gate split.
Its verdict is retained unchanged.

- Date: 2026-10-23.
- Campaign: `codeindex-release-79bbc61fc2e9435e`.
- Suite: `codeindex-release` version 1, hash
  `0e1c05471d5b73a352fec12ba20aaafa363799102295e9c847a570570eb02aca`.
- Subject revision: `3b6b791d148ef6e96bcddd7850e1bc3c43cc4516`.
- Model: `ollama/qwen3.8:27b-mlx`, digest
  `5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e`.
- Environment hash:
  `a22d9f8a8b5e41b7c7bfffc0b1f123f34a77ca5715354618d682e53a4bff4690`.
- Accepted artifact:
  `aba08ea73b5ebbce2d769b964295d26dea196799cb97b4ef962cd3437a58d6c0`.
- Candidate artifact:
  `e016b65103b31126815b06e5baf232997ec6344ee5760a45bb701b9606137593`.
- Target metric: `retrievalBytes`.
- Claim class: `local-model-scoped`; release authority: false.

## Execution status

The fixed plan contained 18 cases × 3 treatments × 3 repetitions = 162 slots.
All 162 final slot results are valid. Ten earlier timed-out attempts remain
retained; they were replayed explicitly with `--resume --retry-timed-out` after
the host-sleep cause and replay behavior were recorded. No completed non-timeout
answer was rerun.

## Verdict

**Local regression: NOT PASSED.** The valid failed answers and metric findings
remain evidence and are not retried for a luckier sample.

Overall candidate-versus-accepted trends favored the candidate:

| Measure | Accepted | Candidate | Candidate / accepted |
| --- | ---: | ---: | ---: |
| Correctness | 92.6% | 94.4% | — |
| `retrievalBytes` | 8,029.5 | 4,713 | 0.587 |
| `toolCalls` | 4.0 | 3.25 | 0.813 |
| `tokens` | 9,200 | 9,047.5 | 0.983 |
| `wallTimeMs` | 53,695.5 | 44,644.5 | 0.831 |

The original gate nevertheless failed on:

- one per-case candidate correctness loss in `locate-stale-file-error`;
- the candidate token threshold against `no-index` (297.8%);
- implementation-class `retrievalBytes` ratio 3.024 and wall-time ratio 1.145.

## Attribution

The `locate-stale-file-error` failed repetition used ordinary lexical tools and
did not call CodeIndex. It found the expected definition but named one additional
file containing the same discriminator. The other eight treatment/repetition
observations for that case were exact. This is retained as a model error, not an
index response defect.

The implementation-class byte finding was dominated by model-selected full-file
ordinary reads. Candidate repetitions read the relevant source and test files in
full, while accepted repetitions more often selected bounded ranges. The excess
bytes were not returned by CodeIndex.

The no-index token threshold did not distinguish accepted from candidate. Median
tokens were 3,070 for `no-index`, 9,531 for accepted, and 9,142 for candidate.
Both CodeIndex treatments exceeded the threshold; candidate remained below
accepted.

These attributions explain the result but do not alter it. The campaign remains
`NOT PASSED` under its predeclared policy.

## 2026-10-23 policy split

Future local-model qualification does not copy this moving three-treatment
comparison. It uses the frozen 18-case suite, `no-index`, one fixed canonical
CodeIndex artifact, and three paired repetitions. Only the pinned model
environment changes between comparable campaigns. EVAL-029 (#56) tracks that
implementation.

Candidate architecture is judged separately by the 270-slot frontier campaign
with `deepseek/deepseek-flash` in EVAL-028 (#36). Local qualification neither
authorizes nor blocks it. The
current executable `release` command still has the obsolete local-regression
precondition; EVAL-030 (#57) must land before #36 can run.
