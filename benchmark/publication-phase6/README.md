# Publication Policy Phase 6 Evidence

Phase 6 decisions for
[codeindex-publication-policy-redesign.md](../../documentation/codeindex-publication-policy-redesign.md).

The files contain aggregate counts only: no source text, symbol names, query text,
credentials, or absolute paths.

Date: 2026-10-20

## M5: default `find_symbol` exposure

### Method

For each corpus, the current TypeScript extractor built the serializable fact bundle and
the finalizer ran in `report` mode. Bindings were grouped by exact simple name. A
binding's exposure is its strongest exposure across project contexts. Each name received
the presence bitmask of the exposures that contain at least one binding with that name.

The comparison answers the M5 question directly:

- `published` returns only names with `P`.
- `visible` returns names with `P` or `R`.
- The current open default (`any`) also returns names with only `I`.

### Name-presence counts

| Corpus | Files | Symbols | Published | Reachable | Internal | Distinct names |
|---|---:|---:|---:|---:|---:|---:|
| TypeScript compiler | 77 | 17,010 | 8,674 | 202 | 8,134 | 12,830 |
| Material UI | 1,063 | 6,719 | 3,909 | 550 | 2,260 | 3,209 |
| VS Code | 4,935 | 161,735 | 89,864 | 5,415 | 66,456 | 75,469 |

Exact-name presence masks:

| Corpus | P | R | I | PR | PI | RI | PRI |
|---|---:|---:|---:|---:|---:|---:|---:|
| TypeScript compiler | 5,370 | 37 | 6,159 | 56 | 1,154 | 3 | 51 |
| Material UI | 1,638 | 88 | 933 | 419 | 48 | 7 | 76 |
| VS Code | 34,997 | 1,074 | 32,258 | 1,038 | 4,608 | 173 | 1,321 |

### Result

| Corpus | `published` names | `visible` names | `any` names | Internal-only added by `any` |
|---|---:|---:|---:|---:|
| TypeScript compiler | 6,631 | 6,671 | 12,830 | 6,159 (+92.3% over visible) |
| Material UI | 2,181 | 2,276 | 3,209 | 933 (+41.0% over visible) |
| VS Code | 41,964 | 43,211 | 75,469 | 32,258 (+74.7% over visible) |

Decision: default to `visible`.

- `any` adds 6,159 / 933 / 32,258 internal-only exact names with no visible match. That is
  query pollution, not additional navigation value.
- `published` removes 40 / 95 / 1,247 reachable-only names. These are navigable
  declarations reached from a published surface.
- `visible` therefore keeps every non-internal name while excluding the noisy class.

The measurement took 7.2 s / 8.7 s / 32.9 s.

## G-A/G-A2: source association

`publication-report` now compares emitted roots for G-A and an independent compiler
reachability truth for G-A2. G-A2 truth maps authored declarations to source positions,
then requires every truth declaration to have a visible lexical binding and every visible
lexical declaration to occur in truth. Production facts are used only for the comparison.

| Corpus | G-A | G-A2 | Truth declarations | Visible declarations | Missing | Extra |
|---|---|---|---:|---:|---:|---:|
| TypeScript compiler | passed | passed | 9,191 | 9,191 | 0 | 0 |
| VS Code | passed | passed | 99,780 | 99,780 | 0 | 0 |
| Material UI styled engine | passed | passed | 16 | 16 | 0 | 0 |

All three normative corpora pass both gates. The Material UI corpus is the
`packages/mui-styled-engine` package, which is TypeScript-first and therefore has an
unambiguous declaration-emit truth. The hybrid `packages/mui-material` package uses
hand-authored `.d.ts` files alongside JavaScript wrappers; declaration emit does not
represent that package's API, so it remains a non-normative probe rather than a gate.
Aggregate counts are in `ga2-evidence.json`; no symbol names or paths are retained.

The independent truth pass also exercised production fixes for merged import/local
symbols, imported namespace re-exports, public constructor parameter properties,
synthetic-default root sites, string-literal and computed object members, class
expressions, private constructor parameter properties, and declaration reachability for
conditional/indexed-access aliases.

## Oracle production corpus

The frozen Oracle Phase 0 corpus was measured with `publication-report` in report mode:
1,237 files, 29,399 symbols, 187,835 occurrences, and zero S3/O2/L1/F1 violations.
M7 measured 5,886 routine pairs, one spec-defined cursor, 197 overload groups, 905 body
forwards, zero body-less specifications, and zero unclassified body-less specifications. This establishes G-F on
the frozen corpus.

G-B through G-E were then checked against the same frozen source, PL/Scope export, and
current production facts. Aggregate results are in `oracle-gates.json`.

| Gate | Result | Evidence |
|---|---|---|
| G-B cross-file exposure | passed | 119,923 cross-file references; all 119,923 targets published; 0 internal-only; 0 exceptions |
| G-C usage | failed | 90 CALL usage mismatches and 444 ASSIGNMENT mismatches among matched references; 7,318 CALLs and 618 assignments remain unresolved |
| G-D references | failed | 171,718 / 188,297 recall (91.20%); 171,718 / 171,718 precision (100%); 0 extras |
| G-E pairing | passed (frozen) | 5,886 routine pairs; 0 required body-less declarations; 0 heading mismatches; 0 cursor pairs; 1 cursor fully defined in its spec; REF CURSOR types excluded |
| Q1 signatures | blocked live | frozen export: 5,654 / 5,654 matched spec/body signatures equal; live `USER_IDENTIFIERS` is empty |

### Method

PL/Scope truth was first reduced to the policy-visible inventory. Parameters, iterators,
and declarations whose PL/Scope context chain is owned by a routine were excluded as
ephemeral; nested routines and package-level declarations were retained. This is
necessary because the production index intentionally stores no parameters or ordinary
locals. G-D used exact path/line/column/name keys and no location tolerance. G-C compared
the same keys and required the CALL bit or write bit to be set. G-B joined references to
their target symbol and checked cross-file exposure.

Reference resolution now indexes nested `DECLARE` block locals, emits each
resolvable prefix of a member chain, and treats PL/Scope assignment rows at a
declaration position as initializers rather than references. These changes
raised G-D recall from 74.59% to 91.20% and removed all reference extras. G-C and
G-D still fail on ambiguous overloads and unresolved record-member types.

### Parser comparison

The same frozen corpus, PL/Scope export, truth policy v2, and gate validator were run
with both Oracle parsers. Structural remains the production parser.

| Metric | Structural | ANTLR |
|---|---:|---:|
| Symbols / occurrences | 29,399 / 208,513 | 34,379 / 159,717 |
| Declaration matched / missing / extra | 36,794 / 14 / 1 | 35,670 / 902 / 1,025 |
| Reference matched / missing / extra | 171,718 / 16,579 / 0 | 119,156 / 67,088 / 3,866 |
| Reference recall / precision | 91.20% / 100.00% | 63.98% / 96.86% |
| CALL matched / mismatch / missing | 47,330 / 90 / 7,318 | 11,648 / 238 / 42,852 |
| ASSIGNMENT matched / mismatch / missing | 14,862 / 444 / 618 | 0 / 14,462 / 829 |
| Cross-file references / internal targets | 119,923 / 0 | 78,582 / 0 |

ANTLR does not strictly improve any required metric and regresses declarations,
references, calls, and assignments, so the parser is not switched.

G-E used the frozen source inventory (610 package specs, 606 bodies, 606 pairs, four
spec-only packages) plus production diagnostics and definition occurrences. The four
spec-only packages declare no routines or cursors. Pairing ignores parameter-default
clauses and treats an omitted mode as `IN`; this added 52 routine pairs. Body declarations
that match no specification heading remain private instead of producing a heading-mismatch
diagnostic. A cursor already fully defined in its package specification needs no body, and
a `REF CURSOR` declaration is a type, not a callable cursor. G-E now passes on the frozen
corpus; Q1 remains a separate live check.

Q1 cannot be re-verified against the live database now: `USER_IDENTIFIERS` currently has
zero rows. `ALL_PROCEDURES` (6,705 rows) and `ALL_ARGUMENTS` (23,798 rows) are available,
but they do not carry PL/Scope signature hashes. The live schema also has 614 package
specs and 610 bodies, while the frozen corpus has 610 and 606, so a live check must first
be restricted to the frozen `(OWNER, OBJECT_NAME)` inventory. A fresh live signature check
requires recompiling that inventory with `PLSCOPE_SETTINGS=IDENTIFIERS:ALL`, which is a
database-changing operation and needs explicit approval.

## K3: CommonJS

P-2 found no `export =` module in the three public corpora. The repository fixture passes
resolution, but `getExportsOfModule` exposes no consumer-facing name for `export =`, and
identifier and expression forms do not share one defensible binding name. K3 is resolved
as deferred: CommonJS files remain indexed under the existing non-publication semantics.
No `commonjs` binding site is emitted and no CommonJS root is published.

## Q2: real-task thresholds

Thresholds are recorded in the policy under "Real-task evaluation". The A/B run itself
is blocked on the private evaluation harness and model transcripts. No task success,
token, tool-call, or false-absence metric is claimed here.

## Enforced invariants

S3, O2, L1, and F1 are measured during production finalization. `enforce` mode fails the
candidate on any violation. The Phase 2 corpora reported zero violations for S3, O2, L1,
and F1; the Oracle fixture reported zero after Phase 5. Qualification-only ANTLR parser
overrides remain report-only because they are not production builds.
