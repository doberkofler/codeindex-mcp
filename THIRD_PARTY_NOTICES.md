# Third-Party Notices

## Oracle PL/SQL lexer grammar

CodeIndex vendors `grammar/oracle/PlSqlLexer.g4` and the generated
`src/adapters/oracle/generated/PlSqlLexer.ts` lexer.

- Upstream project: `antlr/grammars-v4`
- Upstream path: `sql/plsql/PlSqlLexer.g4`
- Upstream commit: `e199816b3f1a7a49ea1ad84fb6b87c382ea36a33`
- Upstream SHA-256: `fd82384ba3ba2f5a7b070a977cd77a05c01fefbfb52938d35dfaf472a2e6e59e`
- Upstream license: Apache License 2.0
- `scripts/downloadOracleGrammar.ts` verifies that digest, applies the local
  header and alternative-quote adaptations, and rewrites
  `grammar/oracle/PlSqlLexer.g4`.

Local lineage and adaptations:

- Lexer layout and the TypeScript base-class wiring follow `plsqldoc` release
  `1.6.0`, commit `8c8a44b668833c5603f5e5c1761837fd56dbc4fd`.
- `PlSqlLexer.isValidAlternativeQuotedString` generalizes Oracle alternative
  quote delimiters. This tracks `antlr/grammars-v4#5029`.
- Generated lexer output is post-processed by
  `scripts/generateOracleGrammar.mjs` to remove an unused import and to mark
  unused semantic-predicate parameters with the repository's underscore
  convention. No lexer behavior changes.
- `src/adapters/oracle/plSqlLexerBase.ts` is a minimal TypeScript adaptation of
  the upstream base class, retaining only the newline predicate used by the
  grammar.

The grammar and generated lexer are distributed under the Apache License 2.0.
The rest of CodeIndex MCP is distributed under the MIT license in `LICENSE`.
