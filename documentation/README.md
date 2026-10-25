# Documentation

Operational and design documentation for CodeIndex MCP.

| Document | Purpose |
| --- | --- |
| [Architecture](./architecture.md) | Core design, generation lifecycle, storage, symbol/binding/exposure model, validation invariants, and query contracts |
| [TypeScript/JavaScript adapter](./typescript-adapter.md) | Shipped extractor behavior, publication classification, production-pilot status, validation, limitations, and enhancement decisions |
| [Oracle adapter](./oracle-adapter.md) | Static Oracle 19c SQL/PL/SQL extraction, manifest configuration, symbols, references, and package dependencies |
| [Oracle O1 qualification contract](./oracle-qualification-contract.md) | Authoritative truth population, exclusions, ambiguity rule, gates, report identity, and change control |
| [ORDS and cross-language resolution](./ords-cross-language.md) | Planned HTTP, ORDS, and PL/SQL route evidence and cross-language graph construction |
| [Roadmap](./roadmap.md) | Ordered delivery phases, acceptance gates, stop rules, and open decisions |
| [Maintainer guide](./maintainer-guide.md) | Runtime contracts, verification, performance, security, and release discipline |
| [User guide](./user-guide.md) | Installation, configuration, MCP/CLI/console usage, and troubleshooting |
| [MCP evaluation strategy](./mcp-evaluation-strategy.md) | Product usefulness, performance, test data, agent A/B gates, and local-model evaluation |
| [Codebase testing strategy](./codebase-testing-strategy.md) | Test classes, module seams, ownership, fixture policy, and workflow targets |
| [Evaluation harness](./evaluation-harness.md) | Implemented methodology for controlled index-versus-baseline comparisons |
| [Migration coverage](./migration-coverage.md) | Audit of preserved, generalized, deferred, and intentionally excluded design knowledge |
| [Enhancements: dependency decisions](./enhancements.md) | Dependency retention decisions, rejected library additions, and links to open dependency work |
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
