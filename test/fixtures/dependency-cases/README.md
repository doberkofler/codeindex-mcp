# Dependency case fixture

Reviewed ground truth for `find_dependencies`. The fixture is intentionally
small and independent of `dependency-graph` and `dependency-impact`, whose exact
result sets are already pinned by earlier tests.

## Source graph

| File | Authored dependency |
| --- | --- |
| `src/roots/direct.ts` | `import {debounce} from 'lodash'` |
| `src/roots/reexport.ts` | `export {debounce} from 'lodash'` |
| `src/roots/inner.ts` | `import {debounce} from 'lodash'` |
| `src/roots/barrel.ts` | `export * from './inner.js'` |
| `src/roots/named.ts` | `export {work} from './inner.js'` |
| `src/consumers/shared.ts` | imports from `roots/direct.ts` and `roots/reexport.ts` |
| `src/consumers/viaBarrel.ts` | imports from `roots/barrel.ts` |
| `src/consumers/viaNamed.ts` | imports from `roots/named.ts` |
| `src/consumers/unusedBinding.ts` | imports only the non-package `unrelated` binding through `roots/barrel.ts` |
| `src/consumers/page01.ts` … `page12.ts` | import from `roots/direct.ts` |
| `src/cycle/a.ts` | imports `lodash` and `cycle/b.ts` |
| `src/cycle/b.ts` | imports `cycle/a.ts` |

## Package edges

The four direct package consumers are:

- `src/cycle/a.ts` — `import`
- `src/roots/direct.ts` — `import`
- `src/roots/inner.ts` — `import`
- `src/roots/reexport.ts` — `export`

`src/roots/reexport.ts` carries one named binding:
`debounce` imported as `debounce` and exported as `debounce`.

## Authored re-export edges into `src/roots/inner.ts`

- `src/roots/barrel.ts` — `export-all`, raw specifier `./inner.js`
- `src/roots/named.ts` — `export`, binding `work` re-exported as `work`

## Dependency impact

Impact groups every module under the direct target consumer that starts its
shortest authored path:

| Direct root | Paths |
| --- | --- |
| `src/cycle/a.ts` | `src/cycle/a.ts` (1), `src/cycle/b.ts` (2) |
| `src/roots/direct.ts` | `src/roots/direct.ts` (1), `src/consumers/page01.ts` … `page12.ts` (2), `src/consumers/shared.ts` (2) |
| `src/roots/inner.ts` | `src/roots/inner.ts` (1), `src/roots/barrel.ts` (2), `src/roots/named.ts` (2), `src/consumers/unusedBinding.ts` (3), `src/consumers/viaBarrel.ts` (3), `src/consumers/viaNamed.ts` (3) |
| `src/roots/reexport.ts` | `src/roots/reexport.ts` (1), `src/consumers/shared.ts` (2) |

`src/consumers/shared.ts` appears under both of its direct roots.

Current semantics prove authored-module reachability, not binding use.
`src/consumers/unusedBinding.ts` is therefore impacted even though the binding
it imports is not backed by `lodash`. This entry is expected to change only when
binding-aware façade analysis replaces reachability.
