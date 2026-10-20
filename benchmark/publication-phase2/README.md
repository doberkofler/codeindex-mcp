# Publication Policy Phase 2 Evidence

Report-only measurements for
[codeindex-publication-policy-redesign.md](../../documentation/codeindex-publication-policy-redesign.md).

The JSON files contain aggregate values only. They contain no source text, query text,
symbol names, credentials, or absolute paths. Local diagnostic artifacts stay outside
the repository.

Date: 2026-10-20

## Commands

```bash
pnpm build

NODE_OPTIONS=--max-old-space-size=8192 node dist/cli.mjs publication-report \
  --root ~/.cache/codeindex-benchmark/projects/typescript \
  --project-file ~/.cache/codeindex-benchmark/projects/typescript/src/compiler/tsconfig.json \
  --output benchmark/publication-phase2/typescript.json

NODE_OPTIONS=--max-old-space-size=16384 node dist/cli.mjs publication-report \
  --root ~/.cache/codeindex-benchmark/projects/vscode \
  --project-file ~/.cache/codeindex-benchmark/projects/vscode/src/tsconfig.json \
  --output benchmark/publication-phase2/vscode.json

NODE_OPTIONS=--max-old-space-size=12288 node dist/cli.mjs publication-report \
  --root ~/.cache/codeindex-benchmark/projects/material-ui \
  --project-file ~/.cache/codeindex-benchmark/projects/material-ui/packages/mui-material/tsconfig.json \
  --output benchmark/publication-phase2/material-ui.json
```

`--diagnostics <path>` writes bounded relative-path examples for O2/S3/L1/F1 classes.
Use `--skip-prototypes` for fast measurement-only runs.

## Results

| Corpus | Files | Symbols | Occurrences | Published | Nested functions | Definition sites | Union / intersection |
|---|---:|---:|---:|---:|---:|---:|---:|
| TypeScript compiler (`typescript.json`) | 77 | 33,134 | 260,291 | 8,630 | 5,988 | 33,620 | 7,060 / 224 |
| VS Code (`vscode.json`) | 4,935 | 293,866 | 1,864,302 | 110,128 | 1,160 | 295,962 | 28,589 / 659 |
| Material UI (`material-ui.json`) | 1,063 | 17,463 | 68,543 | 3,130 | 47 | 17,467 | 447 / 94 |

Nested TypeScript function extents: TypeScript compiler 127,430 total lines, p95 67,
maximum 4,858; VS Code 15,701 total lines, p95 43, maximum 244; Material UI 832 total
lines, p95 119, maximum 148.

Bindings per symbol were 1 for every symbol because Phase 1 emits one lexical binding.
Sites per binding reached 13, 8, and 3 respectively. JavaScript files appeared only in
Material UI: 530 JavaScript files, 529 ESM and 1 CommonJS. No CommonJS publication form
is enabled.

## Prototype outcomes

P-1 declaration emission and maps covered every authored file with zero emit errors.
Root-only comparison is partial:

| Corpus | Emitted modules | Mapped modules | Truth exports | Published roots | Missing roots | Extra roots |
|---|---:|---:|---:|---:|---:|---:|
| TypeScript compiler | 77 | 77 | 6,010 | 3,004 | 3,009 | 3 |
| VS Code | 4,935 | 4,935 | 19,254 | 18,679 | 575 | 0 |
| Material UI | 892 | 892 | 2,523 | 1,199 | 1,530 | 0 |

Missing roots are expected: aliases, default roots, internal `export *`, and projection
have not landed. G-A and G-A2 remain partial until Phase 4 implements full independent
truth.

P-2 export-table results:

| Corpus | Named external aliases | Namespace | Default | External stars | Missing alias bindings |
|---|---:|---:|---:|---:|---:|
| TypeScript compiler | 0 | 0 | 0 | 0 | 0 |
| VS Code | 0 | 0 | 0 | 0 | 0 |
| Material UI | 1,329 | 1 | 146 | 150 | 1,136 |

CommonJS `export =` is covered by `test/fixtures/commonjs-project` and the report test.
No public corpus in this set exercised it.

## Invariants

S3, O2, L1, and F1 measured zero violations on all three TypeScript corpora and on the
repository corpus. The Oracle fixture measured two O2
`parameter_type_reference_owner` cases. Parameter type references inherit the routine
owner until Phase 5 implements nested parameter ownership; the class is report-only.

## Blocked measurements

Surface addresses and reachability steps remain 0 because the Phase 4 projection slice
has not landed. M11/M12 ceilings are consequently provisional only: the external
surface ceiling stays 10,000 and reachability is unresolved. DDL work remains blocked
by the evidence checkpoint.
