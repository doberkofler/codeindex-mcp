# Documentation

Operational and design documentation for CodeIndex MCP.

| Document | Purpose |
| --- | --- |
| [Architecture](./architecture.md) | Core design, generation lifecycle, storage, extractor seam, and query contracts |
| [Publication policy redesign](./codeindex-publication-policy-redesign.md) | Accepted symbol, binding, exposure, schema, and query contract |
| [Publication policy progress](./codeindex-publication-policy-redesign-todo.md) | Implementation checklist, measurements, and open-decision status |
| [TypeScript/JavaScript adapter](./typescript-adapter.md) | Shipped extractor behavior, production-pilot status, validation, limitations, and enhancement backlog |
| [Oracle adapter](./oracle-adapter.md) | Static Oracle 19c SQL/PL/SQL extraction, manifest configuration, symbols, references, and package dependencies |
| [ORDS and cross-language resolution](./ords-cross-language.md) | Planned HTTP, ORDS, and PL/SQL route evidence and cross-language graph construction |
| [Roadmap](./roadmap.md) | Ordered delivery phases, acceptance gates, stop rules, and open decisions |
| [Maintainer guide](./maintainer-guide.md) | Runtime contracts, verification, performance, security, and release discipline |
| [User guide](./user-guide.md) | Installation, configuration, MCP/CLI/console usage, and troubleshooting |
| [MCP evaluation strategy](./mcp-evaluation-strategy.md) | Product usefulness, performance, test data, agent A/B gates, and local-model evaluation |
| [Codebase testing strategy](./codebase-testing-strategy.md) | Unit, adapter, protocol, system, qualification, and test-data cleanup plan |
| [Evaluation harness](./evaluation-harness.md) | Proposed methodology for controlled index-versus-baseline comparisons |
| [Migration coverage](./migration-coverage.md) | Audit of preserved, generalized, deferred, and intentionally excluded design knowledge |
| [Enhancements: dependency removal](./enhancements.md) | Dependency-removal TODOs, retention decisions, and rejected library additions |
| [Source-line counter](./tools/countSourceLines.py) | Local measurement helper for repository size |

## Scope

These documents describe the public, language-neutral implementation, its
TypeScript/JavaScript and Oracle extractors, and the planned ORDS adapter family.
The architecture is intended to support additional source languages through
adapters. It intentionally contains no consumer-specific workspace paths, corpus
content, evaluation transcripts, credentials, or proprietary source excerpts.

The evaluation harness, public synthetic cases, suites, and reviewed aggregate
reports live under [`evaluation/`](../evaluation/README.md). Private corpora,
proprietary source, hidden cases, raw transcripts, and restricted results remain
outside the public tree; only reviewed aggregate evidence may be cited publicly.

## Version

Documentation tracks the released implementation. When behavior and a released
tag disagree, the tagged code is authoritative.
