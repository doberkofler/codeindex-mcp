# Oracle Grammar Gap Fixtures

These fixtures freeze the known parser gaps recorded in
[`documentation/oracle-antlr.md`](../../../documentation/oracle-antlr.md#7-known-grammar-gaps).
Each file is intentionally small and exercises one construct. The parser tests
assert that the current pinned grammar still reports a parse diagnostic; update
or remove a fixture when its gap is fixed.

| Fixture | Construct |
| --- | --- |
| `rem-comment.sql` | SQL*Plus `REM` comment with a tab |
| `keyword-identifier.pks` | Non-reserved keyword used as an identifier |
| `constant-size-type.pks` | Constant expression in a type size |
| `xmltable-returning-sequence.sql` | `XMLTABLE ... RETURNING SEQUENCE BY REF` |
| `json-strict.pkb` | `IS JSON(STRICT)` |
| `sqlplus-exec.sql` | SQL*Plus `EXEC` |
| `nullable-field.pks` | `DATE NULL` record field marker |
| `record-insert.sql` | Record value in `INSERT ... VALUES` |
| `wrapped.pkb` | Wrapped source (out of scope, not a grammar fix target) |

The fixtures are not part of the qualification corpus. They exist to make
grammar work and local adaptations reproducible.
