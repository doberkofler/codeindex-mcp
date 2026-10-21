# Controlled TypeScript semantic fixture

A reviewed, disposable TypeScript workspace for semantic evaluation cases. It is
small enough to verify by hand and contains no runtime, package, or network
dependencies.

Each directory isolates one semantic pattern that a single-identifier text
search handles poorly:

| Directory | Pattern |
| --- | --- |
| `src/renamed` | A public symbol is exported under a different name. |
| `src/barrels` | References travel through a multi-hop barrel chain and a final rename. |
| `src/shadow` | Two modules declare the same common type name with different identities. |
| `src/contracts` | Classes implement one contract while another module references the contract name. |
| `src/types` | A type-only re-export gives one type a second public name. |
| `src/defaults` | Consumers import and use one default export under local aliases. |

The fixture is committed as source text. Cases under `../cases` declare exact
expected files relative to the repository root. The E0 review in
`../../audits/semantic-e0.md` records the TypeScript language-service result and
the model-free grep admission measurement for every case.

`tsconfig.json` is the fixture's own project file. It is not part of the
repository build, and the fixture never emits output.
