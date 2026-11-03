# @codeindex/adapter-sdk

Language-neutral protocol for CodeIndex adapters.

An adapter is a trusted ESM package that exports exactly one named
`codeIndexAdapter` value:

```ts
import {defineAdapter} from '@codeindex/adapter-sdk';

export const codeIndexAdapter = defineAdapter({
	manifest: {protocolVersion: 1, id: 'custom', implementationVersion: '1.0.0', displayName: 'Custom'},
	create: () => ({
		id: 'custom',
		version: '1.0.0',
		displayName: 'Custom',
		discoveryText: 'Searches custom sources.',
		sourceExtensions: ['.custom'],
		ignoredSegments: ['node_modules'],
		limitations: [],
		scan: (config) => scanManifest(config),
		build: (config, scan) => extractFacts(config, scan),
		configFiles: () => [],
		isSourceFile: (path) => path.endsWith('.custom'),
	}),
});
```

Name it in configuration:

```json
{
	"extractors": [
		{"id": "custom", "module": "@example/codeindex-adapter-custom", "project": "custom.json"}
	]
}
```

`module` accepts a bare package name or a relative path. Bare packages resolve
from the configuration-file directory (or the workspace root without a
configuration file); relative paths resolve from that same anchor. Absolute paths
and URL schemes are rejected.

`scan`, `build`, `probe`, and the reuse proof may return a value or a Promise.
The host always awaits them. `create()` must return a fresh instance on every
call. `defineAdapter` freezes the envelope and provides author-time typing; the
host validates every external module at runtime.

Protocol version `1` changes only for incompatible interface or fact-schema
changes. Bump `implementationVersion` whenever emitted facts, scanning,
normalization, or reuse semantics change; it participates in reuse identity.

Installing an adapter grants it the same filesystem, environment, and network
authority as the CodeIndex process. This is a trusted-extension model, not a
sandbox.

## Conformance

```ts
import {runAdapterConformance} from '@codeindex/adapter-sdk';
import {codeIndexAdapter} from './index.ts';

const result = runAdapterConformance(codeIndexAdapter);
```

Passing the conformance checks proves protocol shape only, not extraction
quality. Official adapters use the same checks and loader path.
