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
1,237 files, 29,454 symbols, 187,760 occurrences, and zero S3/O2/L1/F1 violations.
M7 measured 5,834 routine pairs, 197 overload groups, 905 body forwards, 55 body-less
specifications, and two unclassified body-less specifications. This establishes G-F on
the frozen corpus. G-B through G-E remain separate corpus gates.

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
