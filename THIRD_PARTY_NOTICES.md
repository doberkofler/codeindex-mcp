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

## Oracle PL/SQL parser grammar

CodeIndex vendors `grammar/oracle/PlSqlParser.g4` and the generated
`src/adapters/oracle/generated/PlSqlParser.ts` and
`src/adapters/oracle/generated/PlSqlParserVisitor.ts` artifacts.

- Upstream project: `antlr/grammars-v4`
- Upstream path: `sql/plsql/PlSqlParser.g4`
- Upstream commit: `e199816b3f1a7a49ea1ad84fb6b87c382ea36a33`
- Upstream SHA-256: `c57ec1819302de05beb08c44792883e159254e361e8627e981d9a3c99a0b4633`
- Upstream license: Apache License 2.0
- `scripts/downloadOracleGrammar.ts` verifies that digest, replaces the upstream
  C++ header marker with the local parser-base import, and rewrites
  `grammar/oracle/PlSqlParser.g4`.

Local lineage and adaptations:

- `src/adapters/oracle/plSqlParserBase.ts` vendors the upstream Antlr4ng parser
  base from `sql/plsql/Antlr4ng/PlSqlParserBase.ts` (SHA-256
  `240545ca222036231d7044ce468e2c4ed0d1a0ef6df190cb71a717b47faccfcb`). The
  only adaptations are the generated-lexer import path, a type-only
  `TokenStream` import, and an explicit `override` on `reset`.
- Generated parser and visitor output is post-processed by
  `scripts/generateOracleGrammar.ts` to remove an unused type alias, mark
  unused semantic-predicate parameters with the repository's underscore
  convention, and remove an unused parser-base import from the visitor. No
  parser behavior changes.
- The parser is generated from the same pinned commit as the lexer. Listener
  generation is disabled; the visitor is required by the semantic workstreams.

The grammar, generated parser, and parser base are distributed under the Apache
License 2.0. The rest of CodeIndex MCP is distributed under the MIT license in
`LICENSE`.
