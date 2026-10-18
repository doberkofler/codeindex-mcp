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

## Design rules

- The core is language-neutral. It must not learn about TypeScript, a specific
  package manager, or a version-control system.
- Compiler objects stay inside an extractor adapter.
- Extractor output is plain, serializable data.
- Persisted paths are workspace-relative POSIX paths.
- Tool responses are bounded; source reads verify freshness before returning.
- Stdout belongs to the MCP transport. Diagnostics use stderr.
- A failed build never replaces the published generation.

## Adding an extractor

1. Implement the interface in `src/extractors/types.ts`.
2. Emit files, declarations, occurrences, dependency edges, diagnostics, and
   source ranges as language-neutral facts.
3. Register the adapter in `src/extractors/registry.ts`.
4. Add fixtures and tests that exercise scanning, extraction, and stale-file
   rejection.
5. Document the adapter and its limitations in the README.

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
