# Contributing

## Prerequisites

- Node.js 26 or newer
- pnpm 12 or newer

## Setup

```bash
pnpm install
pnpm verify
```

`pnpm install` runs the build through the `prepare` script. Use
`pnpm install --ignore-scripts` only when you intentionally want to skip it.

## Checks

| Command | Scope |
| --- | --- |
| `pnpm typecheck` | Source, tests, and console |
| `pnpm lint` | Oxlint |
| `pnpm knip` | Unused files, exports, and dependencies |
| `pnpm format:check` | Oxfmt |
| `pnpm test` | Vitest |
| `pnpm verify` | All of the above |
| `pnpm verify:references` | TypeScript language-service reference cross-check |

Fix the underlying code when a check fails. Do not disable, exclude, or relax a
rule. Configuration changes require explicit review and must not weaken a rule.

## Repository layout

All authored executable source lives under `src/`:

```text
src/core/        language-neutral indexing machinery
src/adapters/    fact producers (TypeScript today; Oracle and ORDS planned)
src/resolvers/   cross-adapter graph joins
src/transports/  MCP, CLI, and loopback console surfaces
src/ui/          browser console application
src/entries/     executable composition roots
```

See [Architecture](./documentation/architecture.md) for the responsibility
boundaries.

## Design rules

- The core is language-neutral. It must not learn about TypeScript, a specific
  package manager, or a version-control system.
- Compiler objects stay inside an extractor adapter.
- Extractor output is plain, serializable data.
- Persisted paths are workspace-relative POSIX paths.
- Tool responses are bounded; source reads verify freshness before returning.
- Stdout belongs to the MCP transport. Diagnostics use stderr.
- A failed build never replaces the published generation.

## Adding an adapter

1. Implement the interface in `src/adapters/types.ts`.
2. Place source-language implementations under `src/adapters/<language>/`.
   Planned metadata and routing adapters live under `src/adapters/oracle/` and
   `src/adapters/ords/`.
3. Emit files, declarations, occurrences, dependency edges, diagnostics, and
   source ranges as language-neutral facts.
4. Register the adapter in `src/adapters/registry.ts`.
5. Add fixtures and tests that exercise scanning, extraction, and stale-file
   rejection.
6. Document the adapter and its limitations in `documentation/`.

Do not add a language-specific branch to the core.

## Tests

Tests use temporary workspaces and temporary SQLite files. Never point a test at
a real checkout. Keep test output quiet.

## Commits and releases

- Keep history linear and readable.
- A release is an immutable tag (`v0.1.0`). Never move or rewrite a published
  tag.
- No npm publication. Consumers pin a GitHub tag.
- Update `CHANGELOG.md` before tagging.
