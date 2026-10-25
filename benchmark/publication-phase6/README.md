# Publication Policy Phase 6 Evidence

Phase 6 decisions for
[publication classification](../../documentation/typescript-adapter.md#42-surface-projection-and-reachability).

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
1,237 files, 29,400 symbols, 223,538 occurrences, and zero S3/O2/L1/F1 violations.
M7 measured 5,886 routine pairs, one spec-defined cursor, 197 overload groups, 905 body
forwards, zero body-less specifications, and zero unclassified body-less specifications. This establishes G-F on
the frozen corpus.

G-B through G-E were then checked against the same frozen source, PL/Scope export, and
current production facts. Aggregate results are in `oracle-gates.json`.

| Gate | Result | Evidence |
|---|---|---|
| G-B cross-file exposure | passed | 131,565 cross-file references; all 131,565 targets published; 0 internal-only; 0 exceptions |
| G-C usage | passed | 0 CALL and 0 ASSIGNMENT usage mismatches; 53,316 / 53,318 CALLs and 15,849 / 15,924 assignments resolved |
| G-D references | passed | 186,742 / 186,877 recall (99.93%); 186,742 / 186,742 precision (100%); 0 extras |
| G-E pairing | passed (frozen) | 5,886 routine pairs; 0 required body-less declarations; 0 heading mismatches; 0 cursor pairs; 1 cursor fully defined in its spec; REF CURSOR types excluded |
| Q1 signatures | passed (live) | 5,886 / 5,886 packaged specification routines have a body definition with an identical PL/Scope signature; 0 mismatches; 0 missing bodies |

### Method

PL/Scope truth was first reduced to the policy-visible inventory. Parameters, iterators,
and declarations whose PL/Scope context chain is owned by a routine were excluded as
ephemeral; nested routines and package-level declarations were retained. This is
necessary because the production index intentionally stores no parameters or ordinary
locals. G-D used exact path/line/column/name keys and no location tolerance. G-C compared
the same keys and required the CALL bit or write bit to be set. G-B joined references to
their target symbol and checked cross-file exposure.

The reference policy omits one further class: **ambiguous Oracle overloads**. The
normative policy states that an ambiguous overload call is omitted with a diagnostic, so
a PL/Scope CALL row whose site the adapter classifies as `ambiguous-overload` is not a
policy-visible occurrence. The gate removes exactly those rows from the truth denominator
and reports the count separately: 1,420 of 188,297 raw CALL rows, all classified as CALL,
each paired with one bounded ambiguity diagnostic. Every other PL/Scope row stays in the
denominator, and no emitted occurrence is exempted.

That removal was a post-processing step in this historical measurement. Contract
[`oracle-o1@1`](../../documentation/oracle-qualification-contract.md) makes the same rule
executable inside `qualify:oracle` and reports it as
`excludedByReason.omitted_ambiguous_overload`. The counts above are the retained Phase 6
evidence and are not rewritten by the contract.

Resolution now covers:

- declaration completeness, including package-body locals and nested `DECLARE` blocks;
- `%TYPE`/`%ROWTYPE` anchors, local `SUBTYPE` aliases, records, cursor rows, and
  collection element types, with member chains reconstructed across consecutive index
  groups;
- package specification/body targets through one package lookup;
- overload selection by arity, named association, defaults, parameter direction, call
  position, and static argument types (exact match first, then scalar family), with
  inheritance for the built-in JSON types;
- CALL, assignment, `OUT`/`IN OUT`, `SELECT INTO`, indexed assignment, and
  parenthesis-less invocation usage.

A `BULK COLLECT INTO` target assigns the element record fields by position: the compiler
reports one write per selected item, positioned on the collection that receives the rows
and named after the record field the column fills. The parser records the selected-item
count, the resolver expands the target's element record, and a `FETCH` (which has no
authored select list) is left unexpanded because its row shape is decided by the cursor.
Declarations in a package-body initialization block are indexed with the body so their
references resolve.

Remaining disagreements are 135 of 186,877 policy-visible references: 75 `FETCH ... BULK
COLLECT` element writes whose cursor row type is outside the indexed extent, 58 references
to ordinary locals that the index intentionally does not store, and 2 ambiguous local
calls. They are recorded here rather than hidden.

### Parser comparison

The same frozen corpus, PL/Scope export, truth policy v2, and gate validator were run
with both Oracle parsers. Structural remains the production parser.

| Metric | Structural | ANTLR |
|---|---:|---:|
| Symbols / occurrences | 29,400 / 223,538 | 34,379 / 159,717 |
| Declaration matched / missing / extra | 36,795 / 13 / 1 | 35,670 / 902 / 1,025 |
| Reference matched / missing / extra | 186,742 / 135 / 0 | 119,156 / 67,088 / 3,866 |
| Reference recall / precision | 99.93% / 100.00% | 63.98% / 96.86% |
| CALL matched / mismatch / missing | 53,316 / 0 / 2 | 11,648 / 238 / 42,852 |
| ASSIGNMENT matched / mismatch / missing | 15,849 / 0 / 75 | 0 / 14,462 / 829 |
| Cross-file references / internal targets | 131,565 / 0 | 78,582 / 0 |

The ANTLR row is the 2026-10-20 measurement with the same truth policy. It does not
strictly improve any required metric and regresses declarations, references, calls, and
assignments, so the parser is not switched.

G-E used the frozen source inventory (610 package specs, 606 bodies, 606 pairs, four
spec-only packages) plus production diagnostics and definition occurrences. The four
spec-only packages declare no routines or cursors. Pairing ignores parameter-default
clauses and treats an omitted mode as `IN`; this added 52 routine pairs. Body declarations
that match no specification heading remain private instead of producing a heading-mismatch
diagnostic. A cursor already fully defined in its package specification needs no body, and
a `REF CURSOR` declaration is a type, not a callable cursor.

Q1 was re-verified against the live database on 2026-10-21. The frozen inventory was
recompiled with `PLSCOPE_SETTINGS=IDENTIFIERS:ALL` and its approved dependents, then
`USER_IDENTIFIERS` was exported and restricted to the frozen `(OBJECT_TYPE, OBJECT_NAME)`
inventory. The export is byte-identical to the frozen Phase 0 export (926,164 rows), all
objects are `VALID`, and every packaged specification routine has a body definition with an
identical signature hash.

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
