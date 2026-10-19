#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ "${CODEINDEX_SKIP_BUILD:-0}" != "1" ]]; then
	pnpm build
fi

exec node dist/cli.mjs benchmark-suite \
	--suite benchmark/suites/typescript-public.json \
	"$@"
