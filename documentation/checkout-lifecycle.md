# Checkout move, copy, and delete semantics

Status: implemented and verified. Answers PROD-006 ([#52]) and closes the WP3
gap in the [TypeScript/JavaScript adapter](./typescript-adapter.md#91-remaining-pilot-todos-by-work-package).

The index database lives outside the checkout, so a checkout can move, be
copied, or be deleted while the database survives. This page states the
supported outcome and the recovery step for each case, and names the tests that
prove it.

## 1. Identity model

| Concept | Derived from | Purpose |
| --- | --- | --- |
| storage key | real workspace root, extractor id, project files | Selects the default database directory; always bound to one physical checkout |
| project id | `project.id`, `CODE_INDEX_PROJECT_ID`, or the storage key | Logical identity reported by `index_status` and stored on facts |
| working-copy id | random UUID created with the database | Database-local identity, stable for the life of that database |
| workspace fingerprint | SHA-256 of the canonical root, stored in `metadata` | Rejects a database bound to a different checkout |

A configured project id never changes the storage location. Two checkouts that
share one configuration therefore share the logical id but not the default
database.

## 2. Supported outcomes

| Case | Database | Generation | Recovery step |
| --- | --- | --- | --- |
| Move | New storage key, new database; the old database is untouched and orphaned | Rebuilt from the new root; never reused from the old root | `codeindex-cli clean --all --yes` reclaims the old database |
| Copy | New storage key, new database, new build lease, new working-copy id | Built independently; the source database is not attached or mutated | None; `clean --all --yes` reclaims either database when it is no longer needed |
| Delete | Survives the deleted checkout | Still published in the orphaned database | `codeindex-cli clean --all --yes` for the default storage root; remove a custom `storage.directory` entry directly. The default `clean` cannot resolve the deleted root. |

The build lease and owner marker are database-local. A database whose owning
process exited is still cleanable: owner markers written by dead process ids are
ignored, and cleanup does not inspect or repair the lease table.

## 3. Explicit database override

`storage.database` and `CODE_INDEX_DATABASE` name one SQLite file for one
checkout. Opening that file from a second checkout fails with a `different
working copy` error before a writer connection opens, so the first checkout's
database is never mutated. Recovery: give each checkout its own path, remove the
old database with `clean --yes`, then rebuild.

## 4. Evidence

Regression coverage:

- `test/checkoutLifecycle.test.ts` — copy isolation, move rebuild, explicit
  shared-database rejection, and cleanable delete with a crashed owner marker
  and an expired lease.
- `test/config.test.ts` — a pinned project id does not change the storage
  location.
- `test/cleanup.test.ts` — `clean --all` reclaims a legacy explicit-id directory
  and never reaches the current project from the default scope.

Retained checks on the implementation commit:

1. `pnpm verify` — typecheck, Oxlint, Knip, and Oxfmt clean; 133 test files and
   882 tests passed, including the focused modules above.
2. Built `dist/cli.mjs` with a sandboxed `HOME` and a pinned `project.id`:
   - update the source tree, copy the tree, update the copy — the storage root
     held one project directory before and two after, each with its own
     generation;
   - rename the source tree and update — the storage root then held three
     project directories and the run reported a rebuild;
   - delete a checkout, then run `clean --all --yes` — the orphaned database and
     a manually created legacy `legacy-project/index.sqlite` were both reclaimed
     (2 targets, 0 remaining entries).

[#52]: https://github.com/doberkofler/codeindex-mcp/issues/52
