# Oracle controlled qualification corpus

Ten synthetic Oracle 19c PL/SQL cases exercise the O1 semantic contract end to
end. They are versioned source, not production source, and they are
contract-agnostic.

| Case | Files | Contract coverage |
| --- | --- | --- |
| 1 | `ciq_types.pks`, `ciq_types.pkb` | Package specification/body pairing; public and private routines |
| 2 | `ciq_types.pks`, `ciq_types.pkb` | Public and private variables, constants, exceptions, and cursors |
| 3 | `ciq_types.pks` | Parameters, subtypes, records, fields, ref cursors, associative and varray collections |
| 4 | `ciq_core.pkb`, `ciq_dependent.pkb` | Calls, reads, assignments, and definitions across scopes |
| 5 | `ciq_core.pks`, `ciq_core.pkb`, `ciq_dependent.pkb` | Named and positional arguments; overload selection |
| 6 | contract tests | Ambiguous-overload diagnostics and the exact omission rule |
| 7 | `ciq_dependent.pkb`, `ciq_standalone.*` | Internal package dependencies and cross-package calls |
| 8 | `ciq_standalone.fnc`, `ciq_standalone.prc` | Standalone function and procedure publication |
| 9 | `ciq_nested.pkb`, `ciq_standalone.prc` | Nested routines, block scopes, loops, and local declarations |
| 10 | `ciq_types.pkb`, `ciq_core.pkb` | Every live exclusion class and each gate's failure path |

## Install and qualify

The fixtures compile only `CIQ_`-prefixed objects in an isolated namespace. They
never recompile application packages.

```bash
sqlplus -s "$ORACLE_USER/$ORACLE_PASSWORD@$ORACLE_SERVER" <<'SQL'
SET DEFINE OFF
ALTER SESSION SET PLSCOPE_SETTINGS = 'IDENTIFIERS:ALL';
@setup/ciq_employee.sql
@database/ciq_types.pks
@database/ciq_types.pkb
@database/ciq_core.pks
@database/ciq_core.pkb
@database/ciq_dependent.pks
@database/ciq_dependent.pkb
@database/ciq_nested.pks
@database/ciq_nested.pkb
@database/ciq_standalone.fnc
@database/ciq_standalone.prc
EXIT SQL.SQLCODE;
SQL
```

Generate the read-only plan, review `plan/compile.sql`, then apply the same plan:

```bash
pnpm qualify:oracle:live --root test/fixtures/oracle-qualification-corpus \
  --manifest test/fixtures/oracle-qualification-corpus/oracle-index.json \
  --output "$HOME/.local/share/codeindex-mcp/oracle-live/ljs-ciq-20261025"

pnpm qualify:oracle:live --root test/fixtures/oracle-qualification-corpus \
  --manifest test/fixtures/oracle-qualification-corpus/oracle-index.json \
  --output "$HOME/.local/share/codeindex-mcp/oracle-live/ljs-ciq-20261025" \
  --approval <hash>
```

After qualification, drop the `CIQ_` objects and `CIQ_EMPLOYEE` table when they
are no longer needed.

## Scope

This corpus proves selected semantic contracts with exhaustive counted facts.
It does not establish production-corpus recall, representativeness, or a
population claim; the production bundle owns that evidence.
