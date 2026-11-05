# Retention policy

Every derived artifact CodeIndex creates has one declared bound and one code path
that enforces it. Repeated builds, schema upgrades, benchmark runs, evaluation
runs, and qualification runs therefore converge instead of accumulating.

| Category | Bound | Enforced by |
| --- | --- | --- |
| Index database | One published generation and one superseded generation per workspace. The write-ahead log is bounded by `journal_size_limit`. | `IndexDatabase`, `applyWalPolicy`, and `codeindex-cli clean` |
| Analytics | At most 10 event files, 30 days of age, and 10 MiB per active file. | `createAnalyticsRecorder` |
| Schema backup | One recovery point per index database. A superseded backup is removed only after the replacement schema has been created and passes `pragma integrity_check` and `pragma foreign_key_check`. | `openDatabaseConnections`, `pruneSchemaBackups` |
| Benchmark workspace | At most 4 entries and 24 hours of age under the temporary directory. | `codeindex-cli clean --all` |
| Benchmark scratch database | At most 4 entries and 24 hours of age under the temporary directory. | `codeindex-cli clean --all` |
| Benchmark project checkout | Retained while `prepare.json` names the checkout directory at its pinned revision. Unreferenced, superseded, or explicitly discarded checkouts are removable. | `benchmarkCheckoutPlan`, `clean --all`, `clean --benchmark-projects` |
| Evaluation workspace and database | At most 4 entries and 24 hours of age below one evaluation state root. | `codeindex-cli clean --all` |
| Evaluation report | At most 5 result entries and 30 days of age below one evaluation state root. | `codeindex-cli clean --all` |
| Oracle evidence bundle | Every bundle referenced by a committed Oracle descriptor is retained. Other bundles below `oracle-live` are superseded and removable. | `oracleEvidencePlan`, `clean --all` |
| Repository output | Not managed. `dist`, `coverage`, `release-artifacts`, benchmark results, and checked-in evaluation workspaces are owned by the build and release tooling. | `clean` reports the category as declined |

## `codeindex-cli clean`

`clean` is a dry run unless `--yes` is passed. It always reports every candidate
and every decision:

- `would remove` / `remove` for candidates;
- `retain` with the bound that keeps an entry (`within_bound`, `required_bundle`,
  or `suite_needs_checkout`);
- `refuse` with the refusal reason (`active_owner`, `protected_path`, or
  `dirty_worktree`);
- `decline` for categories the command intentionally does not manage.

Without `--all`, `clean` targets only the current workspace database. With
`--all`, it also bounds benchmark residue, prepared project checkouts, Oracle
evidence, and evaluation state. `--benchmark-projects` removes every prepared
checkout even while it is current; `--discard-dirty` is the explicit approval
required to remove a dirty checkout or worktree.

An index with a live owner is never removed. A path inside the protected working
copy is never removed. After benchmark or evaluation cleanup, stale Git worktree
registrations are pruned from the repository, so removing a detached worktree
does not leave a registration behind.

## Abrupt termination

Normal benchmark and evaluation commands remove their own workspaces in
`finally` blocks. Abrupt termination (SIGKILL, host crash, or container stop)
cannot run those blocks, so the next `clean --all` reclaims the residue by the
count and age bounds above.

## Oracle bundle gate

`pnpm test:oracle:bundle` requires the bundle referenced by
`benchmark/oracle-production-20261027/corpus.json`. `clean --all` discovers
committed `benchmark/*/corpus.json` descriptors and retains every external root
they reference. A bundle that no descriptor references is superseded and may be
removed.
