# Agent Rules for CodeIndex MCP

This repository is a standalone code index: a language-neutral core, one
TypeScript/JavaScript extractor, an MCP adapter, a CLI, and a loopback console.
It is not product code for any particular consumer.

## Commands

```bash
pnpm install
pnpm build               # dist/mcp.mjs, dist/cli.mjs, dist/console.mjs, dist/console/
pnpm verify              # tsc, Oxlint, Knip, Oxfmt, Vitest
pnpm verify:references   # TypeScript language-service comparison
pnpm test
pnpm knip
```

`prepare` runs the same build as `pnpm build`. Never commit `dist` or
`node_modules`.

## Invariants

- Stdout belongs exclusively to the MCP transport. Diagnostics and the version
  banner use stderr. Analytics never move diagnostics off stderr.
- The core owns indexing, freshness, pagination, bounds, storage, publication,
  and stale-file checks. It must not import a language compiler, a package
  manager, or a version-control client.
- Extractor adapters emit only serializable facts. Compiler objects stay inside
  the adapter.
- Queries read one published generation. Never expose `building` rows.
- Rebuilds run in a worker thread; the MCP transport must stay responsive while
  a build is in progress. The bundle must dispatch `workerData` before MCP or CLI
  startup.
- Continuous watching and one-file reconciliation are mandatory in normal MCP
  sessions. Filesystem events are hints; the scanner is authoritative.
- Exactly one process owns the build lease. Non-owners remain readers and observe
  the externally published generation.
- Analytics are enabled by default, local, versioned, bounded, and contain no
  source text, prompts, queries, symbol names, credentials, or absolute paths.
  `CODE_INDEX_ANALYTICS=false` disables file writes.
- `--debug` and `DEBUG=codeindex:*` must never write to stdout.
- A failed build must not replace the published generation.
- Any schema change bumps `SCHEMA_VERSION` and rebuilds the derived database.
  Never add an in-place schema migration. An incompatible database is moved aside
  as one `.schema-<version>.bak` file and recreated.
- `read_symbol` must verify the current file hash, reject dirty paths, and return
  `stale_file` instead of stale source.
- Persisted paths are workspace-relative POSIX paths.
- Tool responses are bounded by `CODE_INDEX_MAX_RESULT_BYTES`; source responses
  are also bounded by `CODE_INDEX_MAX_READ_LINES`.
- Tool output must not contain stack traces, credentials, or absolute source
  paths outside `index_status.scope`.
- Configuration is external. The package must contain no defaults for a specific
  consumer workspace, package manager, or language project layout beyond the
  TypeScript extractor's own `tsconfig.json` default.

## Scope

Index only the project selected by configuration and the chosen extractor. Do not
add cross-language edges, embeddings, or full-text search without an explicit
scope decision. A new language is a new adapter, not a core branch.

## Configuration changes

Changes to `tsconfig*.json`, `oxlint.config.ts`, `oxc.config.ts`,
`oxfmt.config.ts`, `knip.config.ts`, `vitest.config.ts`, `vite.config.ts`, or
`package.json` lint/build scripts require explicit approval. Fix code before
weakening a check.

## Tests

Tests use temporary fixture workspaces and temporary SQLite files. Do not point
tests at a real checkout. Keep Vitest output noise-free: no `console.*` and no
expected diagnostics printed to stdout or stderr.

MCP protocol tests use `InMemoryTransport` and the official client. They verify
the tool surface, structured envelopes, and stable error codes without starting
a model client.
