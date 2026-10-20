package parser

import (
	"unicode"

	"github.com/antlr4-go/antlr/v4"
)

// PlSqlLexerBase state
type PlSqlLexerBase struct {
	*antlr.BaseLexer
}

func (l *PlSqlLexerBase) IsNewlineAtPos(pos int) bool {
	la := l.GetInputStream().LA(pos)
	return la == -1 || la == '\n'
}

// isValidAlternativeQuotedString mirrors the repository lexer's TypeScript
// predicate for Oracle q-quoted strings.
func (l *PlSqlLexerBase) isValidAlternativeQuotedString() bool {
	characters := []rune(l.GetText())

	if len(characters) < 5 {
		return false
	}

	openingDelimiter := characters[2]
	closingDelimiter := characters[len(characters)-2]

	if unicode.IsSpace(openingDelimiter) {
		return false
	}

	switch openingDelimiter {
	case '[':
		return closingDelimiter == ']'
	case '{':
		return closingDelimiter == '}'
	case '<':
		return closingDelimiter == '>'
	case '(':
		return closingDelimiter == ')'
	default:
		return closingDelimiter == openingDelimiter
	}
}
