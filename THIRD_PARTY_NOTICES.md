# Third-Party Notices

## Oracle PL/SQL lexer grammar

CodeIndex vendors `grammar/oracle/PlSqlLexer.g4`, the upstream Antlr4ng lexer
base at `grammar/oracle/Antlr4ng/PlSqlLexerBase.ts.txt`, and the generated
`src/adapters/oracle/generated/PlSqlLexer.ts` and
`src/adapters/oracle/generated/PlSqlLexerBase.ts` artifacts.

- Upstream project: `antlr/grammars-v4`
- Upstream paths: `sql/plsql/PlSqlLexer.g4`,
  `sql/plsql/Antlr4ng/PlSqlLexerBase.ts`
- Upstream commit: `3f1ca793eb1b72d421a016dd05b1d340dfa1a65e`
- Lexer SHA-256: `aaddaa2f9d40e10ab71e83a402499ae893aa7f03497a631e5c12f2c4cd1d2567`
- Lexer base SHA-256: `60463fb2d8e19ff40b77f1428056f74c7d19bb55263451a0f4a84670e227ae91`
- Upstream license: Apache License 2.0
- `scripts/downloadOracleGrammar.ts` verifies every digest and writes the
  upstream files unmodified.

Local generation adaptations:

- `scripts/generateOracleGrammar.ts` replaces the upstream C++ header marker with
  the local base-class import in a temporary copy of the grammar, then generates
  the lexer.
- Generated lexer output is post-processed to remove an unused import and to mark
  unused semantic-predicate parameters with the repository's underscore
  convention. No lexer behavior changes.
- The generated `PlSqlLexerBase.ts` keeps the upstream predicates, including
  `IsNewlineAtPos` and `IsQQuoteDelimiter`; only its runtime import is reduced to
  the types the file uses.

## Oracle PL/SQL parser grammar

CodeIndex vendors `grammar/oracle/PlSqlParser.g4`, the upstream Antlr4ng parser
base at `grammar/oracle/Antlr4ng/PlSqlParserBase.ts.txt`, and the generated
`src/adapters/oracle/generated/PlSqlParser.ts`,
`src/adapters/oracle/generated/PlSqlParserVisitor.ts`, and
`src/adapters/oracle/generated/PlSqlParserBase.ts` artifacts.

- Upstream project: `antlr/grammars-v4`
- Upstream paths: `sql/plsql/PlSqlParser.g4`,
  `sql/plsql/Antlr4ng/PlSqlParserBase.ts`
- Upstream commit: `3f1ca793eb1b72d421a016dd05b1d340dfa1a65e`
- Parser SHA-256: `2437508c3e8126d0a09c4cc98fc12741a9d25350b4626350805afdcb74956827`
- Parser base SHA-256: `f83c2eab005f3174f2b506c7e553577f96c336fc18e7c456a58c273566c634eb`
- Upstream license: Apache License 2.0
- `scripts/downloadOracleGrammar.ts` verifies every digest and writes the
  upstream files unmodified.

Local generation adaptations:

- `scripts/generateOracleGrammar.ts` replaces the upstream C++ header marker with
  the local parser-base import in a temporary copy of the grammar, then generates
  the parser and visitor.
- The generated `PlSqlParserBase.ts` is the upstream base class with a type-only
  `TokenStream` import and an explicit `override` on `reset`. No parser behavior
  changes.
- Generated parser and visitor output is post-processed to remove an unused type
  alias, mark unused semantic-predicate parameters with the repository's
  underscore convention, and remove an unused parser-base import from the
  visitor. No parser behavior changes.
- The parser is generated from the same pinned commit as the lexer. Listener
  generation is disabled; the visitor is required by the semantic workstreams.

The grammar, generated parser and lexer, and base classes are distributed under
the Apache License 2.0. The rest of CodeIndex MCP is distributed under the MIT
license in `LICENSE`.
