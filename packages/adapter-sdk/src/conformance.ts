import {ADAPTER_PROTOCOL_VERSION, type AdapterManifestType, type AdapterModuleType, type AdapterType} from './types.ts';
import {adapterManifestSchema, parseAdapterSurface} from './schema.ts';

/** One conformance failure with a stable, bounded description. */
export type AdapterConformanceFailureType = Readonly<{check: string; detail: string}>;

/** Result of the SDK conformance checks. */
export type AdapterConformanceResultType = Readonly<{
	ok: boolean;
	failures: readonly AdapterConformanceFailureType[];
}>;

const manifestOf = (module: AdapterModuleType): AdapterManifestType => adapterManifestSchema().parse(module.manifest);

/**
 * Runs the language-neutral conformance checks for one adapter module.
 *
 * Passing proves protocol shape, not semantic extraction quality.
 *
 * @param module - Exported adapter module.
 * @returns Accumulated failures; empty when the module conforms.
 */
export const runAdapterConformance = (module: AdapterModuleType): AdapterConformanceResultType => {
	const failures: AdapterConformanceFailureType[] = [];
	const fail = (check: string, detail: string): void => {
		failures.push({check, detail});
	};

	let manifest: AdapterManifestType;

	try {
		manifest = manifestOf(module);
	} catch {
		return {ok: false, failures: [{check: 'manifest', detail: 'manifest does not match the SDK schema'}]};
	}

	if (manifest.protocolVersion !== ADAPTER_PROTOCOL_VERSION) {
		fail('protocol', `protocol ${String(manifest.protocolVersion)} is not ${String(ADAPTER_PROTOCOL_VERSION)}`);
	}

	let first: AdapterType;
	let second: AdapterType;
	let firstRaw: unknown;
	let secondRaw: unknown;

	try {
		firstRaw = module.create();
		secondRaw = module.create();
		first = parseAdapterSurface(firstRaw);
		second = parseAdapterSurface(secondRaw);
	} catch {
		return {ok: false, failures: [...failures, {check: 'factory', detail: 'factory result does not match the adapter surface'}]};
	}

	if (firstRaw === secondRaw) {
		fail('factory', 'create() returned the same instance twice');
	}

	if (first === second) {
		fail('factory', 'factory results are not independently validated');
	}

	if (first.id !== manifest.id || first.version !== manifest.implementationVersion) {
		fail('identity', 'manifest and adapter identity disagree');
	}

	if (first.sourceExtensions.length === 0) {
		fail('surface', 'sourceExtensions must not be empty');
	}

	try {
		structuredClone({id: first.id, version: first.version, extensions: first.sourceExtensions});
	} catch {
		fail('clone', 'adapter metadata is not structured-clone-safe');
	}

	return {ok: failures.length === 0, failures};
};
