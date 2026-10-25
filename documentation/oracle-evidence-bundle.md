# Oracle O1 evidence bundle

## 1. Status

**READY for the controlled corpus.** `benchmark/oracle-controlled/` binds a
replayable 10-case synthetic Oracle corpus to contract
[`oracle-o1@2`](./oracle-qualification-contract.md) and passes preflight and
qualification. It proves the semantic contract end to end; it is not a
production-scale population claim.

**NOT READY for the historical Phase 0 corpus.** Exact recovery failed on
2026-10-25 (section 4). Its source snapshot and truth exports remain unavailable,
and no production replacement corpus has been frozen. No production-scale
Oracle semantic PASS is claimed.

## 2. Bundle definition

A bundle is one external directory plus the identity files that stay in Git.

The controlled bundle is `benchmark/oracle-controlled/`; the historical Phase 0
identity remains `benchmark/oracle-phase0/`.

| Component | Location | Committed |
| --- | --- | --- |
| Bundle descriptor | `benchmark/oracle-controlled/corpus.json` | yes |
| Source checksums | `benchmark/oracle-controlled/corpus.sha256` | yes |
| Unit map | `benchmark/oracle-controlled/units.json` | yes |
| Artifact checksums | `benchmark/oracle-controlled/plscope.sha256` | yes |
| Qualification report | `benchmark/oracle-controlled/qualification.json` | yes |
| Source snapshot | `<root>/workspace/` | no |
| Recompile plan | `<root>/plan.json` | no |
| Run metadata | `<root>/run.json` | no |
| Truth exports | `<root>/user-identifiers.csv`, `<root>/user-dependencies.csv` | no |
| Source backup | `<root>/user-source-backup.csv` | no |
| Compile evidence | `<root>/compile.log`, `<root>/dependents.log` | no |

`<root>` resolves to
`${CODEINDEX_EVIDENCE_ROOT:-~/.local/share/codeindex-mcp}/oracle-live/<id>`,
where `<id>` is the descriptor's `evidence.externalRoot`. Source text, raw
database exports, credentials, and absolute private paths are never committed.

The descriptor's `evidence.approval` binds the bundle to the exact approved
recompile plan. `plscope.sha256` binds every external artifact. `run.json` must
carry the authoritative `contract` identity (`id`, `version`, `hash`,
`truthPolicy`) plus the exported truth hashes; a run that records a different
contract, or no contract, is not a contract run.

## 3. Preflight

```bash
pnpm build
node dist/cli.mjs oracle-preflight \
  --bundle benchmark/oracle-controlled/corpus.json \
  --output /tmp/oracle-preflight.json
```

| Option | Meaning |
| --- | --- |
| `--bundle <path>` | Descriptor to verify; defaults to `benchmark/oracle-controlled/corpus.json` |
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
replay with `qualify --extractor oracle`, then — only with a separate approval —
apply a plan.

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

A PL/Scope recompile window was approved on 2026-10-25, but it was not exercised:
without SVN access to the original source revision, the replacement corpus would
still lack a frozen source baseline.

## 5. Replacement route

The controlled substitute was chosen instead of recompiling the deployed
application schema: `test/fixtures/oracle-qualification-corpus/` supplies ten
synthetic cases, compiled only as `CIQ_`-prefixed objects in an isolated
namespace. It covers package specification/body mapping, types, parameters,
constants, cursors, records, fields, subtypes, exceptions, collections,
standalone routines, overloads, nested scopes, dependencies, and counted
exclusions. The resulting bundle passes `oracle-o1@2` with 41/41 declarations,
35/35 references, and 7/7 dependencies.

The production replacement route remains blocked, in order:

1. Read access to the SVN repository and revision `78950` of
   `^/ljs_app/trunk/ljs_db/LJS_DB`, or an approved substitute corpus with its own
   frozen revision.
2. An approved Oracle window for `ALTER SESSION SET PLSCOPE_SETTINGS =
   'IDENTIFIERS:ALL'` plus the generated recompile statement list, with the
   approval hash reviewed before execution.
3. Export of identifiers, dependencies, and the source backup into a new
   external root named by a new descriptor revision.

A replacement freezes: repository revision, manifest, normalized source hashes,
Oracle version, NLS and schema settings, object inventory, contract version, and
parser identity. It reuses contract `oracle-o1@2`; the contract hash does not
change because the corpus version is report data, not contract semantics. The
replacement is a new descriptor and a new external root — not a mutation of
`benchmark/oracle-phase0/`.

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

- Acquire SVN access or an approved substitute corpus, then freeze a replacement
  descriptor and external root.
- Exercise the approved PL/Scope recompile window only after the source baseline
  is frozen.
- Replay contract `oracle-o1@2` against the production replacement bundle and
  record the verdict; that replay belongs to ORA-004.
- Verify with `oracle-preflight`; wire it as a mandatory step in the Oracle
  verification workflow (ORA-003).
