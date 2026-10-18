# Documentation

Operational and design documentation for CodeIndex MCP.

| Document | Purpose |
| --- | --- |
| [Architecture](./architecture.md) | Core design, generation lifecycle, storage, extractor seam, and query contracts |
| [User guide](./user-guide.md) | Installation, configuration, MCP/CLI/console usage, and troubleshooting |
| [Evaluation harness](./evaluation-harness.md) | Proposed methodology for controlled index-versus-baseline comparisons |
| [Source-line counter](./tools/countSourceLines.py) | Local measurement helper for repository size |

## Scope

These documents describe the public, language-neutral implementation and its
TypeScript/JavaScript extractor. They intentionally contain no consumer-specific
workspace paths, corpus content, evaluation transcripts, credentials, or
proprietary source excerpts.

Private evaluation material is not part of this repository. The private harness
may pin a released tag and launch the installed MCP executable, but its corpus,
grading rules, results, and architecture notes remain outside the public tree.

## Version

Documentation tracks the released implementation. When behavior and a released
tag disagree, the tagged code is authoritative.
