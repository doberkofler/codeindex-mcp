# Oracle ANTLR Runtime Benchmark

Parser-only benchmark for the pinned Oracle 19c PL/SQL grammar using independent
Go, Rust, and TypeScript runners. Each language writes its own result file; the
combiner merges them into one comparison.

The harness samples 15 Oracle source files from the frozen Oracle evidence
workspace by size quantile (0%, 5%, 10%, ..., 100%) and reports:

- isolated cold parses, one fresh process and empty DFA per file;
- warm repeated parses, one process and shared DFA;
- a one-pass corpus parse, each file once in one process, which is the closest
  approximation to a real index build;
- peak RSS, token counts, prediction mode, and parse diagnostics.

## Layout

| Path | Purpose |
| --- | --- |
| `select-corpus.mjs` | Selects the size-quantile sample and writes `.work/corpus/manifest.json` |
| `prepare-grammar.mjs` | Produces target-specific grammars for Go and Rust |
| `lib.mjs` | Shared process, corpus, statistics, and result helpers |
| `go/` | Go Dockerfile, harness, bases, and `run.mjs` |
| `rust/` | Rust Dockerfile, Cargo project, generated-parser patch, and `run.mjs` |
| `typescript/` | Vite bundle, parser-core harness, and `run.mjs` |
| `combine-results.mjs` | Merges `go.json`, `rust.json`, and `typescript.json` |
| `run-benchmark.mjs` | Runs the selected languages independently, then combines |
| `.work/` | Ignored corpus copy, Docker contexts, bundles, and results |

## Prerequisites

- Docker Desktop or another Docker engine for Go and Rust.
- Node.js 26 or newer.
- `pnpm install` at the repository root, so the TypeScript runner can resolve
  `vite` and the Oracle adapter.

Go and Java are installed only inside `go/Dockerfile`; Rust and the Rust ANTLR
generator are installed only inside `rust/Dockerfile`. The host and repository
receive no toolchain installation.

## Run independently

Each runner selects the same corpus and writes its own result file:

```bash
node benchmark/oracle-antlr-runtime/go/run.mjs
node benchmark/oracle-antlr-runtime/rust/run.mjs
node benchmark/oracle-antlr-runtime/typescript/run.mjs
```

Then combine whatever result files exist:

```bash
node benchmark/oracle-antlr-runtime/combine-results.mjs
```

Or run all three and combine in one command:

```bash
node benchmark/oracle-antlr-runtime/run-benchmark.mjs
```

Useful variants:

```bash
# Go only
node benchmark/oracle-antlr-runtime/run-benchmark.mjs --languages go

# Rust only, then combine
node benchmark/oracle-antlr-runtime/run-benchmark.mjs --languages rust

# Faster smoke run
node benchmark/oracle-antlr-runtime/run-benchmark.mjs --cold-repeats 1 --iterations 3

# Reuse existing Docker images
node benchmark/oracle-antlr-runtime/run-benchmark.mjs --skip-build

# Use a different frozen evidence root
node benchmark/oracle-antlr-runtime/run-benchmark.mjs \
  --evidence /path/to/oracle-live/2eb1e36f6ecdada4
```

The default evidence root is:

```text
~/.local/share/codeindex-mcp/oracle-live/2eb1e36f6ecdada4
```

It must contain `workspace/` with the frozen Oracle sources. The corpus copy is
not committed.

Results are written to:

```text
benchmark/oracle-antlr-runtime/.work/results/go.json
benchmark/oracle-antlr-runtime/.work/results/rust.json
benchmark/oracle-antlr-runtime/.work/results/typescript.json
benchmark/oracle-antlr-runtime/.work/results/summary.json
benchmark/oracle-antlr-runtime/.work/results/summary.md
```

## Measurement contract

- Grammar: repository `grammar/oracle/PlSqlLexer.g4` and `PlSqlParser.g4`.
- Go: ANTLR 4.13.1 tool, `github.com/antlr4-go/antlr/v4 v4.13.1`, Go 1.23.12.
- Rust: `antlr-rust-runtime` 0.34.0 with `antlr4-rust-gen`, Rust 1.95.0.
- TypeScript: `antlr4ng`; parser core is `lexerMs + sllParseMs + llParseMs`,
  excluding tokenization, conditional preparation, and semantic visitors.
- Parse tree is built; no declaration/reference/dependency visitors run.
- Cold: a separate container process per file, so the runtime DFA starts empty.
- Warm: one process, one warmup and five samples per file; the median is
  reported.
- One-pass: all 15 files once in one process with a shared DFA. This is the
  relevant build-shaped number.

Prediction differs by runtime:

- Go and TypeScript use SLL first, then LL on failure.
- Rust uses LL only. The Rust SLL path produced parser errors on this grammar,
  so it is not a valid SLL-first comparison.

## Known limitations

- This is not a full-adapter equivalence test. The Go and Rust harnesses do not
  port the declaration, reference, SQL-name, or dependency visitors, and do not
  implement conditional-compilation preprocessing or solidus-segment recovery.
- Two of the 15 sampled files fall back from SLL to LL for Go and TypeScript.
- The Go runtime prints `unknown recognition error type:` to stdout on some
  fallback paths. The orchestrator skips leading non-JSON text.
- The Rust generated parser is patched to expose `set_bail_on_error`; the pinned
  generator does not forward that facade method.
- The result is a 15-file sample, not the full 1,237-file corpus.

## Reference run

See [`reference-results.md`](./reference-results.md). Do not compare absolute
numbers across machines; compare the relative cold, warm, and one-pass ratios.
