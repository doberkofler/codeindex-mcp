# Fresh-consumer installation and rollback

Status: verified 2026-10-24 for `codeindex-mcp` 0.7.0 at commit
`13e5069c6531e2d0df9f5ccc6fc22445cf2616f3`. Answers PROD-005 ([#51]) and closes
the WP7 evidence gap in the [TypeScript/JavaScript adapter](./typescript-adapter.md#91-remaining-pilot-todos-by-work-package).

The verification installs the released Git dependency into empty consumer
projects, registers it with OpenCode, starts all three installed artifacts,
checks a second checkout and analytics opt-out, then rolls the registration back
and removes the derived database. It changes no installation CLI behavior.

## 1. Environment and artifact identity

| Field | Value |
| --- | --- |
| Machine | Apple M5 Max, 64 GiB |
| OS | macOS 27.0.1 (build 26A434) |
| Architecture | `arm64` |
| Node.js | `v26.10.0` |
| pnpm | `12.15.0` |
| OpenCode client | `v2.1.4` |
| MCP client SDK | `2.3.1` |
| CodeIndex version | `0.7.0` |
| Dependency specifier | `github:doberkofler/codeindex-mcp#v0.7.0` |
| Resolved commit | `13e5069c6531e2d0df9f5ccc6fc22445cf2616f3` |
| Annotated tag object | `9948a6060f80f3a75010e587be83e0af1ac1ec88` |
| Tarball integrity | `sha512-YKECwHaGDdT3NBgzhglmZnWk8PK/gnBxQjZ4msKsedcWcW3PWMA81eiTyMObNBxG9C1lDIT7aIQW6qEDhWh4HQ==` |
| Installed `mcp.mjs` | `c4eebf0fe20824fb498a8052c1805065bf04b03f899b0ca38de3b206a06ad155` |
| Installed `cli.mjs` | `8cf9771b7320f3a38826df3c44af8fc1adf314f3d9f6e31488fd97b8e1023191` |
| Installed `console.mjs` | `13f655efce8a6f15dcee3dfaa5438a72e860124f73e1677431a3a0b5c5a963e0` |

The dependency resolved to the tagged commit and ran `prepare`; pnpm installed
15 packages and the optional `oracledb` install script completed.

The first install attempt used the annotated-tag object SHA in `allowBuilds` and
was rejected. pnpm printed the dereferenced commit SHA as the required key. This
confirms the [user guide](./user-guide.md#install) instruction to use the key
pnpm prints rather than the tag object.

## 2. Fixture

Two independent consumer projects were created under one sandbox:

```text
<consumer-a>/
  .opencode/opencode.jsonc      # pre-existing unrelated configuration
  codeindex.config.json
  package.json
  pnpm-workspace.yaml
  src/index.ts
  tsconfig.json
<consumer-b>/
  codeindex.config.json
  package.json
  pnpm-workspace.yaml
  src/index.ts
  tsconfig.json
```

Consumer A shipped one exported function. Consumer B shipped a different one.
The pre-existing OpenCode configuration contained a comment, a `model` entry, and
an unrelated `other` MCP server. The sandbox used a dedicated `HOME`, so the
consumer index root and OpenCode state could not collide with the operator's.

Install and registration commands:

```bash
pnpm add github:doberkofler/codeindex-mcp#v0.7.0
pnpm exec codeindex-cli mcp install --root . \
  --mcp-path node_modules/codeindex-mcp/dist/mcp.mjs \
  --codeindex-config ./codeindex.config.json
```

Observed install tail:

```text
dependencies:
+ codeindex-mcp 0.7.0

Done in 32.7s using pnpm v12.15.0
```

Observed registration:

```text
Installed codeindex MCP server in .opencode/opencode.jsonc
```

The resulting registration was:

```jsonc
"codeindex": {
	"type": "local",
	"command": [
		"node",
		"node_modules/codeindex-mcp/dist/mcp.mjs",
		"--config",
		"codeindex.config.json"
	]
}
```

The existing comment, `model`, and `other` server survived unchanged. The CLI
touched only the CodeIndex server entry and did not add a `$schema` hint.

## 3. Installed artifacts

### CLI

```bash
pnpm exec codeindex-cli update --config ./codeindex.config.json
pnpm exec codeindex-cli status --config ./codeindex.config.json
pnpm exec codeindex-cli verify --config ./codeindex.config.json
```

Sanitized output:

```text
codeindex-mcp 0.7.0 (update)
Index rebuilt: 10a4f63b-f337-4eaa-adbe-d7eb571fec8e
  duration: 132 ms
  files: 1
  symbols: 1
  occurrences: 1
  dependency edges: 0
  dependency bindings: 0
  diagnostics: 0
codeindex-mcp 0.7.0 (status)
state: published
refresh: current
freshness: current (0 dirty)
generation: 10a4f63b-f337-4eaa-adbe-d7eb571fec8e
project: consumer-a (0f46d165d5c54af7)
root: <sandbox>/consumer-a
project file: <sandbox>/consumer-a/tsconfig.json
extractor: typescript 0.2.0 (compiler 6.0.3)
files: 1
symbols: 1
occurrences: 1
stale files: 0
source changed: false
lease: none
last error: none
codeindex-mcp 0.7.0 (verify)
integrity: ok
generation: 10a4f63b-f337-4eaa-adbe-d7eb571fec8e
metadata counts: match
files: 1
symbols: 1
```

### MCP

OpenCode discovered the project registration and connected:

```text
✓ codeindex  connected
✗ other      failed: NotFound: ChildProcess.spawn (other-server )
```

The unrelated `other` server failure is expected because that fixture command does
not exist. It also confirms OpenCode read the preserved entry.

The installed bundle was then driven by the official MCP client over stdio:

```text
{
  "status": {
    "ok": true,
    "ready": true,
    "freshness": "updating",
    "counts": {
      "files": 1,
      "symbols": 1,
      "occurrences": 1,
      "dependencyEdges": 0,
      "dependencyBindings": 0,
      "diagnostics": 0
    }
  },
  "symbols": {
    "ok": true,
    "count": 1,
    "firstName": "greeting"
  }
}
```

`updating` reports the readable previous generation while the watcher publishes
the replacement. The version banner and diagnostics went to stderr; stdout
carried MCP framing only.

### Console

```bash
pnpm exec codeindex-console --config ./codeindex.config.json --port 0
```

The console started on a loopback port and served both the static bundle and an
authenticated API request:

```text
Console: http://127.0.0.1:<port>/#token=<redacted>
Press Ctrl+C to stop.
```

```text
indexStatus: 200
metaStatus: 200
version: 0.7.0
analyticsEnabled: true
databaseConfigured: true
```

The process shut down cleanly on `SIGTERM`.

## 4. Second checkout

Consumer B installed from the same tag and built its own index. Both checkouts
shared the sandbox home:

| Checkout | Project ID | Database |
| --- | --- | --- |
| consumer A | `0f46d165d5c54af7` | `<index-root>/0f46d165d5c54af7/index.sqlite` |
| consumer B | `e49b73e49d8c5e33` | `<index-root>/e49b73e49d8c5e33/index.sqlite` |

Both databases existed with different generations (`10a4f63b-…` and
`476de0c2-…`). No database was shared between the checkouts.

## 5. Analytics opt-out

Consumer B was run in a separate `HOME` with analytics disabled:

```bash
CODE_INDEX_ANALYTICS=false pnpm exec codeindex-cli update --config ./codeindex.config.json
CODE_INDEX_ANALYTICS=false pnpm exec codeindex-cli status --config ./codeindex.config.json
```

The MCP server was also started with `CODE_INDEX_ANALYTICS=false` and answered
`index_status` successfully. A recursive search of that home found the index
database and no analytics file:

```text
analytics files: 0
```

With analytics left enabled, consumer A wrote
`<index-root>/<project-id>/analytics/events.jsonl`; the opt-out run wrote no
corresponding directory or file.

## 6. Rollback

```bash
pnpm exec codeindex-cli mcp uninstall --root .
pnpm exec codeindex-cli clean --yes
```

Observed registration removal:

```text
Removed codeindex MCP server from .opencode/opencode.jsonc
```

Post-rollback properties:

- no `mcp.servers.codeindex` entry remained;
- the comment, `model`, and unrelated `other` server remained;
- install added no `$schema` key, so no install artifact remained;
- the package remained installed, so the rollback changed configuration and
  derived data only.

`clean --yes` removed each sandbox project's own database. The index root
contained zero files afterwards. The command does not inspect the OpenCode
temporary root or another workspace's database:

```text
remove <index-root>/0f46d165d5c54af7
remove <index-root>/e49b73e49d8c5e33
remaining index files: 0
```

## 7. Acceptance

| Criterion | Result |
| --- | --- |
| Installation starts from an empty project with no prior CodeIndex state | **pass** — two empty consumers installed from `v0.7.0` |
| No step edits a file outside the consumer project and its client config | **pass** — the sandbox `HOME` received only derived state |
| Unrelated client configuration is preserved | **pass** — comment, `model`, and `other` server survived install and uninstall |
| Opt-out produces no analytics file anywhere | **pass** — zero JSONL files under the opt-out home |
| Rollback leaves no CodeIndex entry and no orphan database | **pass** — registration removed and both project databases deleted |
| The record contains no credentials or absolute paths | **pass** — `<sandbox>` and `<index-root>` replace all absolute paths; the console token is redacted |

## 8. Residual observations

- **Resolved after 0.7.0:** `mcp install` no longer writes a `$schema` hint, so
  a rollback cannot confuse a hint the tool added with one the user chose.
  `mcp uninstall` preserves any `$schema` the user already had.
- The first `opencode mcp list` immediately after assigning a private service
  port reported no configured servers; the next invocation, after OpenCode read
  the same project configuration, reported `codeindex` connected. The resolved
  configuration was correct throughout. This is client-side timing, not a
  CodeIndex defect.
- **Resolved after 0.7.0:** `clean` no longer inspects the OpenCode temporary
  root, and it defaults to the current project's database only. `clean --all`
  is the explicit opt-in for every managed database, so a rollback cannot reach
  another workspace's caches.

## 9. Reproduction outline

Use a disposable `HOME`, two empty projects, the exact tag, and the pnpm
`allowBuilds` key that pnpm prints. Run install, registration, CLI update/status/
verify, an MCP handshake, the console on port `0`, a second checkout, an opt-out
run, `mcp uninstall`, and `clean --yes`. Sanitize the temporary root and the
console token before retaining the transcript.

[#51]: https://github.com/doberkofler/codeindex-mcp/issues/51
