import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ADAPTER_PROTOCOL_VERSION, type AdapterManifestType, type AdapterType, parseAdapterManifest, parseAdapterSurface} from '@codeindex/adapter-sdk';
import {configuredAdapters, type ConfigType} from '../core/config/config.ts';

const {dirname, resolve} = path;

/** Stable bounded adapter load failures. */
export type AdapterLoadErrorCodeType =
	| 'adapter_module_not_found'
	| 'adapter_module_invalid'
	| 'adapter_protocol_unsupported'
	| 'adapter_id_mismatch'
	| 'adapter_version_mismatch'
	| 'adapter_module_duplicate';

/** Raised when a configured adapter module cannot be loaded safely. */
export class AdapterLoadError extends Error {
	public readonly code: AdapterLoadErrorCodeType;

	public constructor(code: AdapterLoadErrorCodeType, message: string) {
		super(message);
		this.name = 'AdapterLoadError';
		this.code = code;
	}
}

/**
 * Process-internal descriptor for one loaded adapter.
 *
 * `moduleUrl` is sensitive operational data: it is never persisted, never
 * returned by a tool, and never included in a failure envelope.
 */
export type ResolvedAdapterDescriptorType = Readonly<{
	readonly id: string;
	readonly moduleUrl: string;
	readonly protocolVersion: number;
	readonly implementationVersion: string;
	readonly packageName: string | null;
	readonly packageVersion: string | null;
}>;

/** Loaded adapters plus the descriptors required to reload them in a worker. */
export type AdapterSetType = Readonly<{
	readonly adapters: readonly AdapterType[];
	readonly descriptors: readonly ResolvedAdapterDescriptorType[];
	readonly byId: ReadonlyMap<string, AdapterType>;
}>;

type BuiltinModuleType = Readonly<{readonly load: () => Promise<unknown>; readonly packageName: string}>;

const BUILTIN_SCHEME = 'builtin:';

/**
 * Compatibility aliases for the official adapter IDs.
 *
 * The alias map contains module identities only; it is never derived from a
 * third-party package name. Package extraction replaces these internal entries.
 */
const BUILTIN_MODULES: Readonly<Record<string, BuiltinModuleType>> = {
	typescript: {
		load: async () => {
			const module = await import('./typescript/index.ts');
			return module;
		},
		packageName: '@codeindex/adapter-typescript',
	},
	oracle: {
		load: async () => {
			const module = await import('./oracle/index.ts');
			return module;
		},
		packageName: '@codeindex/adapter-oracle',
	},
};

const moduleCache = new Map<string, Promise<unknown>>();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

const aliasOf = (id: string): string | null => (BUILTIN_MODULES[id] === undefined ? null : `${BUILTIN_SCHEME}${id}`);

/**
 * Resolves one configured specifier to an importable canonical identity.
 *
 * @param specifier - Bare package name, relative path, or builtin alias.
 * @param anchor - Configuration directory, or the workspace root without one.
 * @returns A builtin identity or a file URL.
 * @throws {@link AdapterLoadError} When the specifier cannot be resolved.
 */
const resolveSpecifier = (specifier: string, anchor: string): string => {
	if (specifier.startsWith(BUILTIN_SCHEME)) {
		const id = specifier.slice(BUILTIN_SCHEME.length);

		if (BUILTIN_MODULES[id] === undefined) {
			throw new AdapterLoadError('adapter_module_not_found', `Unknown built-in adapter module: ${specifier}`);
		}

		return specifier;
	}

	if (specifier.startsWith('.')) {
		const candidate = resolve(anchor, specifier);

		if (!existsSync(candidate)) {
			throw new AdapterLoadError('adapter_module_not_found', `Adapter module not found: ${specifier}`);
		}

		return pathToFileURL(candidate).href;
	}

	try {
		const require = createRequire(resolve(anchor, '__codeindex_adapter_resolution__.js'));
		return pathToFileURL(require.resolve(specifier)).href;
	} catch {
		throw new AdapterLoadError(
			'adapter_module_not_found',
			`Adapter module not found: ${specifier}. Install it in the consuming workspace or correct the configured module.`,
		);
	}
};

const importModule = async (moduleUrl: string): Promise<unknown> => {
	const cached = moduleCache.get(moduleUrl);

	if (cached !== undefined) {
		return cached;
	}

	const pending = (async (): Promise<unknown> => {
		if (moduleUrl.startsWith(BUILTIN_SCHEME)) {
			const id = moduleUrl.slice(BUILTIN_SCHEME.length);
			const builtin = BUILTIN_MODULES[id];

			if (builtin === undefined) {
				throw new AdapterLoadError('adapter_module_not_found', `Unknown built-in adapter module: ${moduleUrl}`);
			}

			return builtin.load();
		}

		try {
			return await import(/* @vite-ignore */ moduleUrl);
		} catch {
			throw new AdapterLoadError('adapter_module_not_found', 'Adapter module could not be imported');
		}
	})();

	moduleCache.set(moduleUrl, pending);

	try {
		return await pending;
	} catch (error) {
		moduleCache.delete(moduleUrl);
		throw error;
	}
};

type AdapterModuleShapeType = Readonly<{
	readonly manifest: unknown;
	readonly create: () => unknown;
}>;

const moduleOf = (namespace: unknown, specifier: string): AdapterModuleShapeType => {
	if (!isRecord(namespace)) {
		throw new AdapterLoadError('adapter_module_invalid', `Adapter module has no exports: ${specifier}`);
	}

	const exported = namespace['codeIndexAdapter'];

	if (!isRecord(exported)) {
		throw new AdapterLoadError('adapter_module_invalid', `Adapter module must export one named codeIndexAdapter: ${specifier}`);
	}

	const factory = exported['create'];

	if (typeof factory !== 'function') {
		throw new AdapterLoadError('adapter_module_invalid', `Adapter module must export one named codeIndexAdapter: ${specifier}`);
	}

	const create = (): unknown => {
		const result: unknown = Reflect.apply(factory, undefined, []);
		return result;
	};

	return {manifest: exported['manifest'], create};
};

const manifestOf = (module: AdapterModuleShapeType, specifier: string): AdapterManifestType => {
	try {
		return parseAdapterManifest(module.manifest);
	} catch {
		throw new AdapterLoadError('adapter_module_invalid', `Adapter module has an invalid manifest: ${specifier}`);
	}
};

const surfaceOf = (module: AdapterModuleShapeType, expectedId: string, manifest: AdapterManifestType, specifier: string): AdapterType => {
	let value: unknown;

	try {
		value = module.create();
	} catch {
		throw new AdapterLoadError('adapter_module_invalid', `Adapter factory failed for ${specifier}`);
	}

	let adapter: AdapterType;

	try {
		adapter = parseAdapterSurface(value);
	} catch {
		throw new AdapterLoadError('adapter_module_invalid', `Adapter factory returned an invalid adapter: ${specifier}`);
	}

	if (adapter.id !== expectedId || adapter.id !== manifest.id) {
		throw new AdapterLoadError('adapter_id_mismatch', `Configured adapter id ${expectedId} does not match the exported id ${adapter.id} in ${specifier}`);
	}

	if (adapter.version !== manifest.implementationVersion) {
		throw new AdapterLoadError(
			'adapter_version_mismatch',
			`Adapter ${expectedId} reports implementation version ${adapter.version}, but its manifest declares ${manifest.implementationVersion}`,
		);
	}

	return adapter;
};

const assertProtocol = (manifest: AdapterManifestType, specifier: string): void => {
	if (manifest.protocolVersion !== ADAPTER_PROTOCOL_VERSION) {
		throw new AdapterLoadError(
			'adapter_protocol_unsupported',
			`Adapter ${manifest.id} in ${specifier} implements protocol ${String(manifest.protocolVersion)}; this host supports ${String(ADAPTER_PROTOCOL_VERSION)}`,
		);
	}
};

/**
 * Reads the nearest package.json version above one installed adapter module.
 *
 * @param moduleUrl - Canonical module identity selected by the parent.
 * @returns The declared package version, or null when unavailable.
 */
const packageVersionOf = (moduleUrl: string): string | null => {
	if (moduleUrl.startsWith(BUILTIN_SCHEME)) {
		return null;
	}

	let directory = dirname(fileURLToPath(moduleUrl));

	for (let depth = 0; depth < 4; depth += 1) {
		const candidate = path.join(directory, 'package.json');

		if (existsSync(candidate)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));

				if (isRecord(parsed) && typeof parsed['version'] === 'string') {
					return parsed['version'];
				}
			} catch {
				return null;
			}
		}

		const parent = dirname(directory);

		if (parent === directory) {
			break;
		}

		directory = parent;
	}

	return null;
};

const descriptorOf = (id: string, moduleUrl: string, manifest: AdapterManifestType, packageName: string | null): ResolvedAdapterDescriptorType => {
	const builtin = moduleUrl.startsWith(BUILTIN_SCHEME) ? BUILTIN_MODULES[moduleUrl.slice(BUILTIN_SCHEME.length)] : undefined;

	return {
		id,
		moduleUrl,
		protocolVersion: manifest.protocolVersion,
		implementationVersion: manifest.implementationVersion,
		packageName: builtin?.packageName ?? packageName,
		packageVersion: builtin === undefined ? packageVersionOf(moduleUrl) : manifest.implementationVersion,
	};
};

/**
 * Loads one resolved adapter module and validates its exported contract.
 *
 * @param moduleUrl - Canonical builtin identity or file URL.
 * @param expectedId - Adapter ID named by configuration.
 * @param specifier - Authored specifier used in diagnostics.
 * @returns The adapter and its internal descriptor.
 */
const loadOne = async (
	moduleUrl: string,
	expectedId: string,
	specifier: string,
): Promise<Readonly<{adapter: AdapterType; descriptor: ResolvedAdapterDescriptorType}>> => {
	const namespace = await importModule(moduleUrl);
	const shape = moduleOf(namespace, specifier);
	const manifest = manifestOf(shape, specifier);
	assertProtocol(manifest, specifier);

	if (manifest.id !== expectedId) {
		throw new AdapterLoadError('adapter_id_mismatch', `Configured adapter id ${expectedId} does not match the exported id ${manifest.id} in ${specifier}`);
	}

	const adapter = surfaceOf(shape, expectedId, manifest, specifier);
	const packageName = specifier.startsWith('.') ? null : specifier;
	return {adapter, descriptor: descriptorOf(expectedId, moduleUrl, manifest, packageName)};
};

/**
 * Loads every configured adapter module exactly once per canonical identity.
 *
 * @param config - Resolved configuration naming adapter modules.
 * @returns Loaded adapters and worker descriptors in declaration order.
 * @throws {@link AdapterLoadError} When resolution or validation fails.
 */
export const loadConfiguredAdapters = async (config: ConfigType): Promise<AdapterSetType> => {
	const anchor = config.configPath === null ? config.rootDir : dirname(config.configPath);
	const adapters: AdapterType[] = [];
	const descriptors: ResolvedAdapterDescriptorType[] = [];
	const moduleOwners = new Map<string, string>();

	for (const configured of configuredAdapters(config)) {
		const specifier = configured.module ?? aliasOf(configured.id);

		if (specifier === null) {
			throw new AdapterLoadError(
				'adapter_module_not_found',
				`No adapter module is configured for ${configured.id}; add a module specifier or use a known adapter id.`,
			);
		}

		const moduleUrl = resolveSpecifier(specifier, anchor);
		const existingOwner = moduleOwners.get(moduleUrl);

		if (existingOwner !== undefined && existingOwner !== configured.id) {
			throw new AdapterLoadError('adapter_module_duplicate', `Adapter module ${specifier} is configured for both ${existingOwner} and ${configured.id}`);
		}

		moduleOwners.set(moduleUrl, configured.id);
		// Modules load sequentially so duplicate and identity failures are
		// attributed to the first configured adapter that owns them.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const loaded = await loadOne(moduleUrl, configured.id, specifier);
		adapters.push(loaded.adapter);
		descriptors.push(loaded.descriptor);
	}

	return {
		adapters,
		descriptors,
		byId: new Map(adapters.map((adapter) => [adapter.id, adapter])),
	};
};

/**
 * Reloads the exact adapter identities selected by the parent process.
 *
 * @param descriptors - Process-internal descriptors produced by the parent.
 * @returns Fresh adapter instances in descriptor order.
 * @throws {@link AdapterLoadError} When an identity differs from its descriptor.
 */
export const loadAdaptersFromDescriptors = async (descriptors: readonly ResolvedAdapterDescriptorType[]): Promise<AdapterSetType> => {
	const adapters: AdapterType[] = [];
	const seen = new Set<string>();

	for (const descriptor of descriptors) {
		if (seen.has(descriptor.id)) {
			throw new AdapterLoadError('adapter_module_duplicate', `Adapter module is configured more than once: ${descriptor.id}`);
		}

		seen.add(descriptor.id);
		const specifier = descriptor.moduleUrl.startsWith(BUILTIN_SCHEME) ? descriptor.moduleUrl : descriptor.id;
		// Identity validation is sequential and preserves descriptor order.
		// oxlint-disable-next-line eslint/no-await-in-loop
		const namespace = await importModule(descriptor.moduleUrl);
		const shape = moduleOf(namespace, specifier);
		const manifest = manifestOf(shape, specifier);

		if (manifest.protocolVersion !== descriptor.protocolVersion) {
			throw new AdapterLoadError(
				'adapter_protocol_unsupported',
				`Adapter ${descriptor.id} implements protocol ${String(manifest.protocolVersion)}; the parent selected ${String(descriptor.protocolVersion)}`,
			);
		}

		if (manifest.id !== descriptor.id) {
			throw new AdapterLoadError('adapter_id_mismatch', `Worker loaded adapter ${manifest.id}, but the parent selected ${descriptor.id}`);
		}

		if (manifest.implementationVersion !== descriptor.implementationVersion) {
			throw new AdapterLoadError(
				'adapter_version_mismatch',
				`Worker loaded adapter ${descriptor.id} version ${manifest.implementationVersion}, but the parent selected ${descriptor.implementationVersion}`,
			);
		}

		adapters.push(surfaceOf(shape, descriptor.id, manifest, specifier));
	}

	return {
		adapters,
		descriptors,
		byId: new Map(adapters.map((adapter) => [adapter.id, adapter])),
	};
};

/**
 * Reports whether a value is a resolved adapter descriptor.
 *
 * @param value - Raw worker payload field.
 * @returns True when the descriptor carries every required field.
 */
export const isAdapterDescriptor = (value: unknown): value is ResolvedAdapterDescriptorType =>
	isRecord(value) &&
	typeof value['id'] === 'string' &&
	typeof value['moduleUrl'] === 'string' &&
	typeof value['protocolVersion'] === 'number' &&
	typeof value['implementationVersion'] === 'string' &&
	(value['packageName'] === null || typeof value['packageName'] === 'string') &&
	(value['packageVersion'] === null || typeof value['packageVersion'] === 'string');
