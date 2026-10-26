# Oracle O1 evidence bundle

## 1. Status

**REFERENCES PASS; DEPENDENCIES FAIL for the production replacement corpus.**
`benchmark/oracle-production-20261026/` requalifies the live installed source
inventory of `LJ_UNITTEST` under contract
[`oracle-o1@3`](./oracle-qualification-contract.md): declarations, reference
precision, and reference recall pass; package dependency recall fails and is
owned by [#101](https://github.com/doberkofler/codeindex-mcp/issues/101). The
source snapshot is byte-identical to 2026-10-25. This is the current production
verdict ([evidence](../benchmark/oracle-production-20261026/README.md)); no
production-scale semantic PASS is claimed.

**Historical PASS for the controlled corpus.**
`benchmark/oracle-controlled/` binds a replayable 10-case synthetic Oracle
corpus to contract `oracle-o1@2` and passes preflight and qualification under
that contract. It is retained unchanged as historical evidence; its run record
is rejected by the authoritative contract, and a rerun under `@3` failed because
the live export selects every object of the four PL/Scope types in a shared
schema.

**NOT READY for the historical Phase 0 corpus.** Exact recovery failed on
2026-10-25 (section 4). Its source snapshot and truth exports remain
unavailable. The Phase 0 identity stays frozen and is never overwritten.

## 2. Bundle definition

A bundle is one external directory plus the identity files that stay in Git.

| Bundle | Descriptor | External root | Verdict |
| --- | --- | --- | --- |
| Production replacement | `benchmark/oracle-production-20261026/corpus.json` | `oracle-live/ljs-production-20261026` | REFERENCES PASS; DEPENDENCIES FAIL |
| Production historical | `benchmark/oracle-production-20261025/corpus.json` | `oracle-live/ljs-production-20261025` | NOT READY; superseded contract |
| Controlled substitute | `benchmark/oracle-controlled/corpus.json` | `oracle-live/ljs-ciq-20261025` | historical PASS under `oracle-o1@2` |
| Historical Phase 0 | `benchmark/oracle-phase0/corpus.json` | `oracle-live/2eb1e36f6ecdada4` | NOT READY; root absent |

Each bundle commits the same bounded identity files:

| Component | Location | Committed |
| --- | --- | --- |
| Bundle descriptor | `benchmark/<bundle>/corpus.json` | yes |
| Source checksums | `benchmark/<bundle>/corpus.sha256` | yes |
| Unit map | `benchmark/<bundle>/units.json` | yes |
| Artifact checksums | `benchmark/<bundle>/plscope.sha256` | yes |
| Qualification report | `benchmark/<bundle>/qualification.json` | yes |
| Source snapshot | `<root>/workspace/` | no |
| Recompile plan | `<root>/plan.json` | no |
| Run metadata | `<root>/run.json` | no |
| Truth exports | `<root>/user-identifiers.csv`, `<root>/user-dependencies.csv` | no |
| Source backup | `<root>/user-source-backup.csv` | no |
| Compile evidence | `<root>/compile.log`, `<root>/dependents.log` | no |

`<root>` resolves to
`${CODEINDEX_EVIDENCE_ROOT:-~/.local/share/codeindex-mcp}/oracle-live/<id>`,
where `<id>` is the descriptor's `evidence.externalRoot`. Source text, raw
database exports, credentials, extracted declaration/reference facts, and
absolute private paths are never committed. The object inventory map retains the
file and object names required to replay the bundle; disagreement samples are
retained in the external root only, and the committed reports keep their
aggregate counts.

The descriptor's `evidence.approval` binds the bundle to the exact approved
recompile plan. `plscope.sha256` binds every external artifact. `run.json` must
carry the authoritative `contract` identity (`id`, `version`, `hash`,
`truthPolicy`) plus the exported truth hashes; a run that records a different
contract, or no contract, is not a contract run.

## 3. Preflight

```bash
pnpm build
node dist/cli.mjs oracle-preflight \
  --bundle benchmark/oracle-production-20261026/corpus.json \
  --output /tmp/oracle-preflight.json
node dist/cli.mjs oracle-preflight \
  --bundle benchmark/oracle-production-20261026/corpus.json
```

| Option | Meaning |
| --- | --- |
| `--bundle <path>` | Descriptor to verify; defaults to `benchmark/oracle-production-20261026/corpus.json` |
| `--evidence-root <path>` | Overrides the resolved external root |
| `--output <path>` | Writes the full JSON report |
| `--json` | Emits the report on stdout |

Exit code is `0` only when every artifact and identity check passes; `1`
otherwise, including a missing descriptor or malformed checksum line.

Verified:

- existence and SHA-256 of every `plscope.sha256` artifact;
- existence and SHA-256 of every `corpus.sha256` snapshot file;
- the snapshot project file listed with a checksum in `plan.json`;
- descriptor, plan, and run agreement on approval hash, source hash, config
  hash, and file count;
- `corpus.fileCount`, `corpus.unitCount`, and path coverage of the unit map;
- `run.contract` equals the executable contract identity;
- `run.truth.identifiersSha256` and `run.truth.dependenciesSha256` equal the
  retained export hashes.

Preflight is deliberately DB-free: it imports no Oracle driver, opens no
session, and touches no index or database file. A missing or mismatched artifact
therefore fails before any connection capable of DDL exists. Run it first, then
replay. Applying a plan still requires a separate DDL approval.

### 3.1 Replay

```bash
pnpm build
node dist/cli.mjs oracle-replay --bundle benchmark/oracle-production-20261026/corpus.json
```

Replay is also DB-free. It copies the retained snapshot, recreates the live
project-context layout (`qualification`), runs the production qualification path
against the retained truth exports in a temporary SQLite database, and compares
the report with the committed `qualification.json`. Only the nondeterministic
`generationId` and the uncommitted disagreement samples are ignored. Exit code
is `0` only when every aggregate count, ratio, identity, and exclusion count
matches. A gate failure is reported but does not fail replay when it matches the
retained verdict.

Artifact paths in the report are bundle-relative POSIX paths. Only the resolved
root is absolute, and it is printed once for operator diagnosis.

Report statuses:

| Status | Meaning |
| --- | --- |
| `ok` | Present and matching |
| `missing` | Required artifact or identity absent |
| `mismatch` | Present but contradicts the retained identity |
| `unverified` | Present but not checksum-pinned by any retained manifest |

## 4. Recovery attempt (2026-10-25)

One bounded, read-only attempt. Stop rule: no further search after a negative
result, then freeze a replacement or record NOT READY.

| Check | Result |
| --- | --- |
| `${CODEINDEX_EVIDENCE_ROOT:-~/.local/share/codeindex-mcp}/oracle-live/2eb1e36f6ecdada4` | absent |
| `CODEINDEX_EVIDENCE_ROOT` | unset |
| Spotlight (`mdfind`) for `user-identifiers.csv`, `user-dependencies.csv`, `2eb1e36f6ecdada4` | no hits |
| Depth-6 scan of `$HOME` for the same names and `oracle-live*` | no hits |
| Live `USER_IDENTIFIERS` | 0 rows; PL/Scope `IDENTIFIERS:NONE` |
| Live valid PL/SQL objects | 1,367 |
| Frozen corpus | 1,237 files, 1,240 installed objects, SVN r78950 |
| SVN source recovery | not possible from retained data: only the repo-relative root `^/ljs_app/trunk/ljs_db/LJS_DB` is recorded, with no repository URL and no working copy |

Conclusion: exact recovery is unattainable on two independent axes. The truth
exports are gone and require a PL/Scope recompile to regenerate, and the live
schema is not the Phase 0 snapshot (1,367 versus 1,240 valid objects). Any
regeneration produces a **replacement corpus**, never a restoration. The Phase 0
identity in `benchmark/oracle-phase0/` stays frozen and is never overwritten.

A PL/Scope recompile window was approved and exercised on 2026-10-25 against the
live installed source, producing the production replacement bundle. It cannot
restore the Phase 0 corpus because the original SVN revision is still
unavailable.

## 5. Replacement route

The controlled substitute was chosen instead of recompiling the deployed
application schema: `test/fixtures/oracle-qualification-corpus/` supplies ten
synthetic cases, compiled only as `CIQ_`-prefixed objects. It covered package
specification/body mapping, types, parameters, constants, cursors, records,
fields, subtypes, exceptions, collections, standalone routines, overloads,
nested scopes, dependencies, and counted exclusions. The resulting bundle passes
`oracle-o1@2` with 41/41 declarations, 35/35 references, and 7/7 dependencies
and is retained as historical evidence.

Its `oracle-o1@3` requalification failed on 2026-10-26. The live export selects
every `PACKAGE`, `PACKAGE BODY`, `FUNCTION`, and `PROCEDURE` row in the schema,
and `LJ_UNITTEST` now also holds the 1,246 production objects, so qualification
aborts on an unmapped object after the 10 target objects recompiled. The `CIQ_`
objects and table were dropped afterwards. A controlled rerun requires an
isolated schema or an export scoped to the plan's object list.

The production replacement was first frozen on 2026-10-25 from the live
installed `USER_SOURCE` inventory of `LJ_UNITTEST` and requalified on 2026-10-26
against the same byte-identical source snapshot:

1. The source snapshot was selected from 1,246 installed objects; two objects
   had no usable source, leaving 1,244 files and units.
2. A read-only plan froze the source, generated the recompile SQL, and bound it
   to approval `97c796a2f6a3b228e8a5f34af1c0b6c3087a908deba7f2d14a513299cbdf7ce0`.
3. The approved apply recompiled 1,244 targets and 189 dependents with
   `PLSCOPE_SETTINGS='IDENTIFIERS:ALL'`, left zero invalid objects, and exported
   identifiers, dependencies, and the source backup.
4. Contract `oracle-o1@3` was executed against the regenerated truth.

The replacement has no SVN revision and is not the historical Phase 0 snapshot.
Its result is **REFERENCES PASS; DEPENDENCIES FAIL**. The 2026-10-25 run and the
comparisons with Phase 6 and Phase 8 are recorded in
[`benchmark/oracle-production-20261026/README.md`](../benchmark/oracle-production-20261026/README.md).

A replacement freezes: manifest, source hashes, Oracle version, NLS and schema
settings, object inventory, contract version, parser identity, and the approval
hash. The replacement is a new descriptor and a new external root — not a
mutation of `benchmark/oracle-phase0/` or of the superseded 2026-10-25 bundle.

## 6. Retention, backup, access, deletion

| Concern | Owner | Rule |
| --- | --- | --- |
| External evidence root | Repository maintainer | Kept outside Git on the operator workstation and backed up with the same retention as release evidence |
| Backup | Repository maintainer | One immutable archive of the complete root per frozen corpus version; restore verified by preflight, never by ad-hoc file copies |
| Access | Repository maintainer | Read access for anyone replaying qualification; write access only for the maintainer performing an approved recompile |
| Deletion | Repository maintainer | Deletion requires a superseding frozen bundle or an explicit decision to retire the corpus; a deletion is recorded in the bundle documentation |
| Credentials | Operator | Supplied only through environment variables; never stored in the bundle, descriptor, report, or repository |

Verification after any restore or move is `oracle-preflight`; a bundle that
fails preflight is not a valid backup.

## 7. Follow-ups

- Fix the reference-precision, reference-recall, and dependency-recall defects
  recorded in the production replacement evidence.
- Decide the contract policy for compiler-inferred specification dependencies
  that have no authored reference in indexed source.
- Acquire SVN access only if a future comparison requires the historical Phase 0
  corpus; the current production corpus does not depend on it.
- Keep preflight and replay mandatory before any approved apply.
