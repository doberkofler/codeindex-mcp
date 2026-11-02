# Oracle Grammar Gap Fixtures

These fixtures are the retained manifest of parser gaps and fixes for the current
upstream pin. Grammar provenance is recorded in
[`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md).

Each file is intentionally small and exercises one construct. Open gaps assert
that the current pinned grammar still reports a parse diagnostic. Fixed gaps
assert that it parses without one; keep them as regression evidence.

| Fixture | Construct | Status |
| --- | --- | --- |
| `rem-comment.sql` | SQL*Plus `REM` comment with a tab | Fixed upstream (`#5127`) |
| `keyword-identifier.pks` | Non-reserved keyword used as an identifier | Fixed upstream (`#5131`) |
| `constant-size-type.pks` | Constant expression in a type size | Open |
| `xmltable-returning-sequence.sql` | Invalid `XMLTABLE ... RETURNING SEQUENCE BY REF` clause order | Open |
| `json-strict.pkb` | `IS JSON(STRICT)` | Open |
| `sqlplus-exec.sql` | SQL*Plus `EXEC` | Fixed upstream (`#5129`) |
| `nullable-field.pks` | `DATE NULL` record field marker | Open |
| `record-insert.sql` | Record value in `INSERT ... VALUES` | Open |
| `wrapped.pkb` | Wrapped source (out of scope, not a grammar fix target) | Open |

The fixtures are not part of the qualification corpus. They exist to make
grammar behavior reproducible.
