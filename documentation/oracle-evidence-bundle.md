# Oracle O1 evidence bundle

## 1. Status

**PASS.** `benchmark/oracle-production-20261027/` qualifies the live installed
source inventory of `LJ_UNITTEST` under contract
[`oracle-o1@4`](./oracle-qualification-contract.md): declarations, reference
precision and recall, and package dependency precision and recall all pass. The
103 compiler-inferred dependency rows decided in
[#101](https://github.com/doberkofler/codeindex-mcp/issues/101) are counted as
`compiler_inferred_dependency`
([evidence](../benchmark/oracle-production-20261027/README.md)).

## 2. Bundle definition

A bundle is one external directory plus the identity files that stay in Git.

| Bundle | Descriptor | External root | Verdict |
| --- | --- | --- | --- |
| Production | `benchmark/oracle-production-20261027/corpus.json` | `oracle-live/ljs-production-20261027` | PASS under `oracle-o1@4` |

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
  --bundle benchmark/oracle-production-20261027/corpus.json \
  --output /tmp/oracle-preflight.json
node dist/cli.mjs oracle-preflight \
  --bundle benchmark/oracle-production-20261027/corpus.json
```

| Option | Meaning |
| --- | --- |
| `--bundle <path>` | Descriptor to verify; defaults to `benchmark/oracle-production-20261027/corpus.json` |
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
node dist/cli.mjs oracle-replay --bundle benchmark/oracle-production-20261027/corpus.json
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

## 4. Bundle origin

The production bundle was produced from the installed `USER_SOURCE` inventory of
`LJ_UNITTEST`:

1. The source snapshot was selected from 1,246 installed objects; two objects
   had no usable source, leaving 1,244 files and units.
2. A read-only plan froze the source, generated the recompile SQL, and bound it
   to approval `97c796a2f6a3b228e8a5f34af1c0b6c3087a908deba7f2d14a513299cbdf7ce0`.
3. The approved apply recompiled 1,244 targets and 189 dependents with
   `PLSCOPE_SETTINGS='IDENTIFIERS:ALL'`, left zero invalid objects, and exported
   identifiers, dependencies, and the source backup.
4. Contract `oracle-o1@4` was executed against the retained source and truth,
   including the counted `compiler_inferred_dependency` exclusion decided in
   #101.

A new bundle freezes: manifest, source hashes, Oracle version, NLS and schema
settings, object inventory, contract version, parser identity, and the approval
hash. It is a new descriptor and a new external root, never a mutation of the
published bundle.

The synthetic corpus under `test/fixtures/oracle-qualification-corpus/` remains
available for semantic-contract tests. It compiles only `CIQ_`-prefixed objects
in an isolated schema and is not an evidence bundle.

## 5. Retention, backup, access, deletion

| Concern | Owner | Rule |
| --- | --- | --- |
| External evidence root | Repository maintainer | Kept outside Git on the operator workstation and backed up with the same retention as release evidence |
| Backup | Repository maintainer | One immutable archive of the complete root per frozen corpus version; restore verified by preflight, never by ad-hoc file copies |
| Access | Repository maintainer | Read access for anyone replaying qualification; write access only for the maintainer performing an approved recompile |
| Deletion | Repository maintainer | Deletion requires a superseding frozen bundle or an explicit decision to retire the corpus; a deletion is recorded in the bundle documentation |
| Credentials | Operator | Supplied only through environment variables; never stored in the bundle, descriptor, report, or repository |

Verification after any restore or move is `oracle-preflight`; a bundle that
fails preflight is not a valid backup.

## 6. Follow-ups

- Keep preflight and replay mandatory before any approved apply.
- Recompute the bundle whenever the contract or parser identity changes; a
  superseded bundle is retired rather than edited.
