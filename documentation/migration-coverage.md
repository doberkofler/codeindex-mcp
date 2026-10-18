# Documentation Migration Coverage

## Purpose

This ledger records how reusable design knowledge from the original prototype and
consumer-side planning documents is represented in the standalone project. It is
the deletion gate for those source documents; it contains no consumer-specific
paths, names, source excerpts, corpus, or measurements.

## Coverage

| Source topic | Destination | Disposition |
| --- | --- | --- |
| Retrieval motivation and evaluation method | `evaluation-harness.md` | Generalized |
| Product scope and non-goals | `architecture.md`, `roadmap.md` | Generalized and updated to multi-language scope |
| Stable identity and immutable content | `architecture.md` | Preserved |
| Context-sensitive artifacts | `architecture.md`, `maintainer-guide.md` | Preserved |
| Multi-adapter atomic snapshot model | `architecture.md` | Preserved/generalized |
| Atomic generations and one-writer publication | `architecture.md`, `maintainer-guide.md` | Preserved |
| Freshness, pagination, and bounded retrieval | `architecture.md`, `user-guide.md` | Preserved |
| Edge/evidence separation and confidence | `architecture.md` | Preserved |
| Logical storage concepts and publication checks | `architecture.md`, adapter documents | Generalized |
| TypeScript extraction and dependency semantics | `typescript-adapter.md`, `architecture.md` | Preserved/currentized |
| Production-pilot WP0–WP8 status and remaining gates | `typescript-adapter.md`, `maintainer-guide.md` | Preserved/currentized |
| Dependency-query implementation and enhancements | `typescript-adapter.md` | Preserved/currentized |
| Startup, watcher, lease, and failure contracts | `maintainer-guide.md` | Preserved |
| Performance methodology and promotion gates | `maintainer-guide.md` | Generalized |
| Analytics and console security | `architecture.md`, `maintainer-guide.md`, `user-guide.md` | Preserved |
| SQL and PL/SQL source-unit extraction | `oracle-adapter.md` | Preserved/generalized |
| Oracle dictionary privilege modes | `oracle-adapter.md` | Preserved/generalized |
| Overloads, synonyms, dependencies, and schema facts | `oracle-adapter.md` | Preserved |
| PL/Scope readiness gate | `oracle-adapter.md` | Preserved |
| Source/database drift and provenance | `oracle-adapter.md` | Preserved |
| ORDS routes and authorization facts | `ords-cross-language.md` | Preserved/generalized |
| Cross-language resolution and dynamic residue | `ords-cross-language.md` | Preserved/generalized |
| Delivery phases, stop rules, tool choices, open decisions | `roadmap.md` | Preserved/currentized |
| Controlled case/suite/arm model | `evaluation-harness.md` | Generalized |
| Consumer topology, paths, object names, and endpoint names | none | Intentionally excluded |
| Consumer source-size and Oracle-instance counts | none | Private evidence; intentionally excluded |
| Prompts, transcripts, corpus, grading rules, and stored results | none | Private evidence; intentionally excluded |
| Migration status/diff captures | none | Consumer repository history; intentionally excluded |
| Obsolete prototype status and completed work-package ledger | `CHANGELOG.md` plus current docs | Replaced by shipped state and roadmap |

## Removal gate

Original documents may be removed only after:

1. every source section maps to a row above or receives an explicit new row;
2. all linked destination documents exist and are internally consistent;
3. planned behavior is clearly distinguished from shipped behavior;
4. a repository search finds no consumer-specific identifiers or proprietary
   measurements;
5. the standalone documentation passes formatting/link checks;
6. the owner reviews the diff and explicitly approves source-document removal.

Private raw evidence needed to reproduce historical claims should be archived or
retained separately even when narrative source documents are removed.
