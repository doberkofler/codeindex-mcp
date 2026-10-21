#!/usr/bin/env bash
# Process unchecked items from TODO.md, one fresh opencode session each.
# Item format: "- [ ] #123 title" (md checklist).
# `opencode run` without --continue/--session starts a new session (v2).
set -euo pipefail

QUEUE="${1:-TODO.md}"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"

while true; do
	# First unchecked line; stop when queue is empty.
	item="$(grep -m1 -E '^- \[ \] ' "$QUEUE" || true)"
	[[ -z "$item" ]] && break

	# Refuse to start on a dirty tree (isolation guard).
	if [[ -n "$(git status --porcelain)" ]]; then
		echo "Dirty tree before: $item" >&2
		exit 1
	fi

	# Fresh session: implement, verify, commit. No -c/-s flags.
	# --standalone keeps the run off the shared background service.
	# --auto is required because no operator is present to approve tools.
	"$OPENCODE_BIN" run --standalone --auto "Implement exactly this item, nothing else: ${item#- [ ] }
Rules:
- Run tests/lint/typecheck; fix until green.
- Make one commit (conventional commit message).
- Do not touch other queue items."

	# Guard: agent must have committed and left tree clean.
	if [[ -n "$(git status --porcelain)" ]]; then
		echo "Uncommitted changes after: $item" >&2
		exit 1
	fi

	# Tick item off in the queue (script-owned, not agent-owned), commit it.
	escaped="$(printf '%s' "$item" | sed 's/[][\.*^$/]/\\&/g')"
	sed -i "s/^${escaped}$/- [x] ${item#- [ ] }/" "$QUEUE"
	git add "$QUEUE"
	git commit -m "chore: mark done: ${item#- [ ] }"
done
