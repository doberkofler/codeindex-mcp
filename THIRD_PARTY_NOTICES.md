# Third-Party Notices

## Oracle PL/SQL lexer grammar

CodeIndex vendors `grammar/oracle/PlSqlLexer.g4`, the upstream Antlr4ng lexer
base at `grammar/oracle/Antlr4ng/PlSqlLexerBase.ts.txt`, and the generated
`src/adapters/oracle/generated/PlSqlLexer.ts` and
`src/adapters/oracle/generated/PlSqlLexerBase.ts` artifacts.

- Upstream project: `antlr/grammars-v4`
- Upstream paths: `sql/plsql/PlSqlLexer.g4`,
  `sql/plsql/Antlr4ng/PlSqlLexerBase.ts`
- Upstream commit: `c306207ac870e7c5a95763b518ba3e3a1ca61409`
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
- Upstream commit: `c306207ac870e7c5a95763b518ba3e3a1ca61409`
- Parser SHA-256: `592733617486cb835e37f6c58a8eb40ab5c9d24d29ce58e193ad16d369563b87`
- Parser base SHA-256: `c9a02af5ccecbcc9d285101d9be0ffb97532f61a06e44a5f88a0d0b6b41541cf`
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
