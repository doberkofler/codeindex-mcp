import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import os from 'node:os';
import {hashOf} from './hash.ts';

/** Version of the local-model environment manifest understood by this harness. */
export const ENVIRONMENT_SCHEMA_VERSION = 1 as const;

/** Declared use of a pinned environment. */
export const ENVIRONMENT_PURPOSES = ['smoke', 'calibration'] as const;

export type EnvironmentPurposeType = (typeof ENVIRONMENT_PURPOSES)[number];

/**
 * Generation settings the provider applies when the harness overrides none.
 *
 * A null value is the pinned absence of an explicit model setting: the provider
 * applies its own default at the pinned runtime version. The absence is part of
 * the environment digest, so a later model or runtime change is visible.
 */
export type GenerationSettingsType = Readonly<{
	temperature: number | null;
	topP: number | null;
	topK: number | null;
	repeatPenalty: number | null;
	stop: readonly string[];
}>;

/** Immutable provider identity and generation settings of one local model. */
export type ModelEnvironmentType = Readonly<{
	/** Suite model reference, for example `ollama/qwen3:8b`. */
	reference: string;
	/** Provider digest, never a floating tag or a truncated prefix. */
	digest: string;
	architecture: string;
	parameters: string;
	quantization: string;
	contextLength: number;
	embeddingLength: number;
	generation: GenerationSettingsType;
}>;

/** Host facts that a reproduced execution must observe. */
export type HostFactsType = Readonly<{
	nodeVersion: string;
	platform: string;
	arch: string;
	cpuModel: string;
	cpuCount: number;
	memoryBytes: number;
	osVersion: string;
}>;

/** Host facts plus the declared reference-machine label. */
export type HostEnvironmentType = HostFactsType &
	Readonly<{
		referenceMachine: string;
	}>;

/** Local runtime versions and the Ollama endpoint they serve. */
export type RuntimeEnvironmentType = Readonly<{
	ollama: string;
	opencode: string;
	ollamaEndpoint: string;
}>;

/** Committed description of one reproducible local-model environment. */
export type EnvironmentManifestType = Readonly<{
	schemaVersion: typeof ENVIRONMENT_SCHEMA_VERSION;
	id: string;
	purpose: EnvironmentPurposeType;
	recordedAt: string;
	host: HostEnvironmentType;
	runtime: RuntimeEnvironmentType;
	model: ModelEnvironmentType;
}>;

/** Facts measured from the machine that is about to execute. */
export type EnvironmentProbeType = Readonly<{
	host: HostFactsType;
	runtime: RuntimeEnvironmentType;
	model: ModelEnvironmentType;
}>;

/** One field whose measured value disagrees with the pinned environment. */
export type EnvironmentDifferenceType = Readonly<{
	field: string;
	expected: string;
	observed: string;
}>;

/** Command runner used to read installed runtime versions. */
export type CommandRunnerType = (command: string, args: readonly string[]) => string;

/** JSON transport used to read the Ollama model catalogue. */
export type JsonFetcherType = (url: string, body?: unknown) => Promise<unknown>;

const ENVIRONMENT_KEYS = new Set(['schemaVersion', 'id', 'purpose', 'recordedAt', 'host', 'runtime', 'model']);
const HOST_KEYS = new Set(['referenceMachine', 'nodeVersion', 'platform', 'arch', 'cpuModel', 'cpuCount', 'memoryBytes', 'osVersion']);
const RUNTIME_KEYS = new Set(['ollama', 'opencode', 'ollamaEndpoint']);
const MODEL_KEYS = new Set(['reference', 'digest', 'architecture', 'parameters', 'quantization', 'contextLength', 'embeddingLength', 'generation']);
const GENERATION_KEYS = new Set(['temperature', 'topP', 'topK', 'repeatPenalty', 'stop']);

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const rejectUnknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void => {
	const unknown = Object.keys(value)
		.filter((key) => !allowed.has(key))
		.sort();

	if (unknown.length > 0) {
		throw new Error(`${context} has unknown field(s): ${unknown.join(', ')}`);
	}
};

const requireObject = (value: unknown, context: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new Error(`${context} must be a JSON object`);
	}

	return value;
};

const requireString = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${context} field "${field}" must be a non-empty string`);
	}

	return value;
};

const requireStableId = (value: unknown, field: string, context: string): string => {
	const id = requireString(value, field, context);

	if (!STABLE_ID.test(id)) {
		throw new Error(`${context} field "${field}" must match ${STABLE_ID}`);
	}

	return id;
};

const requireHexDigest = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || !HEX_DIGEST.test(value)) {
		throw new Error(`${context} field "${field}" must be a 64-character lowercase hex digest`);
	}

	return value;
};

const requirePositiveInteger = (value: unknown, field: string, context: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${context} field "${field}" must be a positive integer`);
	}

	return value;
};

const requireNonNegativeNumber = (value: unknown, field: string, context: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`${context} field "${field}" must be a non-negative number`);
	}

	return value;
};

const optionalNonNegativeNumber = (value: unknown, field: string, context: string): number | null =>
	value === null ? null : requireNonNegativeNumber(value, field, context);

const optionalPositiveInteger = (value: unknown, field: string, context: string): number | null =>
	value === null ? null : requirePositiveInteger(value, field, context);

const requireStringArray = (value: unknown, field: string, context: string): readonly string[] => {
	if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string' && item.length > 0)) {
		throw new Error(`${context} field "${field}" must be an array of non-empty strings`);
	}

	return value;
};

const hostOf = (value: unknown): HostEnvironmentType => {
	const record = requireObject(value, 'environment field "host"');
	rejectUnknownKeys(record, HOST_KEYS, 'environment field "host"');

	return {
		referenceMachine: requireString(record['referenceMachine'], 'host.referenceMachine', 'environment'),
		nodeVersion: requireString(record['nodeVersion'], 'host.nodeVersion', 'environment'),
		platform: requireString(record['platform'], 'host.platform', 'environment'),
		arch: requireString(record['arch'], 'host.arch', 'environment'),
		cpuModel: requireString(record['cpuModel'], 'host.cpuModel', 'environment'),
		cpuCount: requirePositiveInteger(record['cpuCount'], 'host.cpuCount', 'environment'),
		memoryBytes: requirePositiveInteger(record['memoryBytes'], 'host.memoryBytes', 'environment'),
		osVersion: requireString(record['osVersion'], 'host.osVersion', 'environment'),
	};
};

const runtimeOf = (value: unknown): RuntimeEnvironmentType => {
	const record = requireObject(value, 'environment field "runtime"');
	rejectUnknownKeys(record, RUNTIME_KEYS, 'environment field "runtime"');

	return {
		ollama: requireString(record['ollama'], 'runtime.ollama', 'environment'),
		opencode: requireString(record['opencode'], 'runtime.opencode', 'environment'),
		ollamaEndpoint: requireString(record['ollamaEndpoint'], 'runtime.ollamaEndpoint', 'environment'),
	};
};

const generationOf = (value: unknown): GenerationSettingsType => {
	const record = requireObject(value, 'environment field "model.generation"');
	rejectUnknownKeys(record, GENERATION_KEYS, 'environment field "model.generation"');

	return {
		temperature: optionalNonNegativeNumber(record['temperature'], 'model.generation.temperature', 'environment'),
		topP: optionalNonNegativeNumber(record['topP'], 'model.generation.topP', 'environment'),
		topK: optionalPositiveInteger(record['topK'], 'model.generation.topK', 'environment'),
		repeatPenalty: optionalNonNegativeNumber(record['repeatPenalty'], 'model.generation.repeatPenalty', 'environment'),
		stop: requireStringArray(record['stop'], 'model.generation.stop', 'environment'),
	};
};

const modelOf = (value: unknown): ModelEnvironmentType => {
	const record = requireObject(value, 'environment field "model"');
	rejectUnknownKeys(record, MODEL_KEYS, 'environment field "model"');

	return {
		reference: requireString(record['reference'], 'model.reference', 'environment'),
		digest: requireHexDigest(record['digest'], 'model.digest', 'environment'),
		architecture: requireString(record['architecture'], 'model.architecture', 'environment'),
		parameters: requireString(record['parameters'], 'model.parameters', 'environment'),
		quantization: requireString(record['quantization'], 'model.quantization', 'environment'),
		contextLength: requirePositiveInteger(record['contextLength'], 'model.contextLength', 'environment'),
		embeddingLength: requirePositiveInteger(record['embeddingLength'], 'model.embeddingLength', 'environment'),
		generation: generationOf(record['generation']),
	};
};

/**
 * Validates one local-model environment manifest.
 *
 * Every fact needed to reproduce the pinned execution is required. A missing
 * digest, quantization, context length, generation setting, runtime version, or
 * host fact is rejected rather than defaulted, because a default would silently
 * describe a different environment.
 *
 * @param value - Parsed JSON value.
 * @returns The validated environment manifest.
 */
export const environmentManifestOf = (value: unknown): EnvironmentManifestType => {
	const record = requireObject(value, 'environment');
	rejectUnknownKeys(record, ENVIRONMENT_KEYS, 'environment');

	if (record['schemaVersion'] !== ENVIRONMENT_SCHEMA_VERSION) {
		throw new Error(`environment field "schemaVersion" must be ${ENVIRONMENT_SCHEMA_VERSION}`);
	}

	const purpose = ENVIRONMENT_PURPOSES.find((item) => item === record['purpose']);

	if (purpose === undefined) {
		throw new Error(`environment field "purpose" must be one of ${ENVIRONMENT_PURPOSES.join(', ')}`);
	}

	const recordedAt = requireString(record['recordedAt'], 'recordedAt', 'environment');

	if (Number.isNaN(Date.parse(recordedAt))) {
		throw new Error('environment field "recordedAt" must be an ISO 8601 timestamp');
	}

	return {
		schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
		id: requireStableId(record['id'], 'id', 'environment'),
		purpose,
		recordedAt,
		host: hostOf(record['host']),
		runtime: runtimeOf(record['runtime']),
		model: modelOf(record['model']),
	};
};

/**
 * Reads and validates a committed environment manifest.
 *
 * @param file - Absolute manifest path.
 * @returns The validated environment manifest.
 */
export const loadEnvironmentManifest = (file: string): EnvironmentManifestType => {
	if (!existsSync(file)) {
		throw new Error(`environment manifest is missing: ${file}`);
	}

	return environmentManifestOf(JSON.parse(readFileSync(file, 'utf8')) as unknown);
};

/**
 * Hashes the complete pinned environment.
 *
 * @param environment - Validated manifest.
 * @returns Lowercase hex SHA-256 digest.
 */
export const environmentHashOf = (environment: EnvironmentManifestType): string => hashOf(environment);

/**
 * Reads the host facts a reproduced execution must observe.
 *
 * @returns Node version, platform, architecture, CPU, memory, and kernel facts.
 */
export const hostFactsOf = (): HostFactsType => {
	const [cpu] = os.cpus();

	return {
		nodeVersion: process.version,
		platform: process.platform,
		arch: process.arch,
		cpuModel: cpu?.model ?? 'unknown',
		cpuCount: os.cpus().length,
		memoryBytes: os.totalmem(),
		osVersion: os.version(),
	};
};

const commandRunnerOf: CommandRunnerType = (command, args) => execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();

const jsonFetcherOf: JsonFetcherType = async (url, body) => {
	const response =
		body === undefined ? await fetch(url) : await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});

	if (!response.ok) {
		throw new Error(`${url} returned HTTP ${response.status}`);
	}

	return (await response.json()) as unknown;
};

const versionOf = (text: string, runtime: string): string => {
	const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u.exec(text);

	if (match === null) {
		throw new Error(`could not read the ${runtime} version from "${text}"`);
	}

	return match[0];
};

const modelNameOf = (reference: string): string => {
	const separator = reference.indexOf('/');

	return separator > 0 ? reference.slice(separator + 1) : reference;
};

const stopValuesOf = (parameters: string): readonly string[] => {
	const stops: string[] = [];

	for (const line of parameters.split('\n')) {
		const match = /^stop\s+(.+)$/u.exec(line.trim());

		if (match?.[1] !== undefined) {
			stops.push(match[1].replace(/^"(.*)"$/u, '$1'));
		}
	}

	return stops;
};

const generationFromParameters = (parameters: string): GenerationSettingsType => {
	const values = new Map<string, string>();

	for (const line of parameters.split('\n')) {
		const match = /^([a-z_]+)\s+(.+)$/u.exec(line.trim());

		if (match?.[1] !== undefined && match[2] !== undefined && !values.has(match[1])) {
			values.set(match[1], match[2].trim());
		}
	}

	const number = (key: string): number | null => {
		const text = values.get(key);

		if (text === undefined) {
			return null;
		}

		if (Number.isNaN(Number(text))) {
			throw new Error(`ollama model generation setting "${key}" is not a number`);
		}

		return Number(text);
	};

	return {
		temperature: number('temperature'),
		topP: number('top_p'),
		topK: number('top_k'),
		repeatPenalty: number('repeat_penalty'),
		stop: stopValuesOf(parameters),
	};
};

const requireRecord = (value: unknown, context: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new Error(`${context} is not a JSON object`);
	}

	return value;
};

const modelProbeOf = (reference: string, tags: unknown, show: unknown): ModelEnvironmentType => {
	const name = modelNameOf(reference);
	const listed = requireRecord(tags, 'ollama /api/tags response')['models'];

	if (!Array.isArray(listed)) {
		throw new Error('ollama /api/tags response has no "models" array');
	}

	const entry = listed.map((item) => requireRecord(item, 'ollama model entry')).find((item) => item['name'] === name);

	if (entry === undefined) {
		throw new Error(`ollama does not serve model "${name}"`);
	}

	const details = requireRecord(requireRecord(show, 'ollama /api/show response')['details'], 'ollama model details');
	const info = requireRecord(requireRecord(show, 'ollama /api/show response')['model_info'], 'ollama model info');
	const architecture = requireRecord(info, 'ollama model info')['general.architecture'];

	if (typeof architecture !== 'string') {
		throw new Error('ollama model info has no "general.architecture"');
	}

	const parameters = requireRecord(show, 'ollama /api/show response')['parameters'];

	if (typeof parameters !== 'string') {
		throw new Error('ollama /api/show response has no "parameters"');
	}

	return {
		reference,
		digest: requireHexDigest(entry['digest'], 'ollama model digest', 'environment'),
		architecture,
		parameters: requireString(details['parameter_size'], 'ollama model parameter_size', 'environment'),
		quantization: requireString(details['quantization_level'], 'ollama model quantization_level', 'environment'),
		contextLength: requirePositiveInteger(info[`${architecture}.context_length`], 'ollama model context_length', 'environment'),
		embeddingLength: requirePositiveInteger(info[`${architecture}.embedding_length`], 'ollama model embedding_length', 'environment'),
		generation: generationFromParameters(parameters),
	};
};

/**
 * Probes the machine that is about to execute and returns measured facts.
 *
 * Installed runtime versions are read from their executables and model identity
 * comes from Ollama's own catalogue, so a manifest can never be validated
 * against itself.
 *
 * @param input - Suite model reference, endpoint, and optional injected probes.
 * @returns Measured host, runtime, and model facts.
 */
export const environmentProbeOf = async (
	input: Readonly<{
		model: string;
		endpoint?: string;
		command?: CommandRunnerType;
		fetchJson?: JsonFetcherType;
		host?: HostFactsType;
	}>,
): Promise<EnvironmentProbeType> => {
	const command = input.command ?? commandRunnerOf;
	const fetchJson = input.fetchJson ?? jsonFetcherOf;
	const endpoint = input.endpoint ?? 'http://127.0.0.1:11434';
	const name = modelNameOf(input.model);
	const [tags, show] = await Promise.all([fetchJson(`${endpoint}/api/tags`), fetchJson(`${endpoint}/api/show`, {model: name})]);

	return {
		host: input.host ?? hostFactsOf(),
		runtime: {
			ollama: versionOf(command('ollama', ['--version']), 'ollama'),
			opencode: versionOf(command('opencode', ['--version']), 'opencode'),
			ollamaEndpoint: endpoint,
		},
		model: modelProbeOf(input.model, tags, show),
	};
};

const difference = (field: string, expected: unknown, observed: unknown): EnvironmentDifferenceType => ({
	field,
	expected: typeof expected === 'string' ? expected : JSON.stringify(expected),
	observed: typeof observed === 'string' ? observed : JSON.stringify(observed),
});

/**
 * Compares a pinned environment with the measured one.
 *
 * @param environment - Committed environment manifest.
 * @param probe - Facts measured before the smoke run.
 * @returns Every differing field, or an empty list when the environment matches.
 */
export const environmentDifferencesOf = (environment: EnvironmentManifestType, probe: EnvironmentProbeType): readonly EnvironmentDifferenceType[] => {
	const checks: readonly Readonly<{field: string; expected: unknown; observed: unknown}>[] = [
		{field: 'host.nodeVersion', expected: environment.host.nodeVersion, observed: probe.host.nodeVersion},
		{field: 'host.platform', expected: environment.host.platform, observed: probe.host.platform},
		{field: 'host.arch', expected: environment.host.arch, observed: probe.host.arch},
		{field: 'host.cpuModel', expected: environment.host.cpuModel, observed: probe.host.cpuModel},
		{field: 'host.cpuCount', expected: environment.host.cpuCount, observed: probe.host.cpuCount},
		{field: 'host.memoryBytes', expected: environment.host.memoryBytes, observed: probe.host.memoryBytes},
		{field: 'host.osVersion', expected: environment.host.osVersion, observed: probe.host.osVersion},
		{field: 'runtime.ollama', expected: environment.runtime.ollama, observed: probe.runtime.ollama},
		{field: 'runtime.opencode', expected: environment.runtime.opencode, observed: probe.runtime.opencode},
		{field: 'runtime.ollamaEndpoint', expected: environment.runtime.ollamaEndpoint, observed: probe.runtime.ollamaEndpoint},
		{field: 'model.reference', expected: environment.model.reference, observed: probe.model.reference},
		{field: 'model.digest', expected: environment.model.digest, observed: probe.model.digest},
		{field: 'model.architecture', expected: environment.model.architecture, observed: probe.model.architecture},
		{field: 'model.parameters', expected: environment.model.parameters, observed: probe.model.parameters},
		{field: 'model.quantization', expected: environment.model.quantization, observed: probe.model.quantization},
		{field: 'model.contextLength', expected: environment.model.contextLength, observed: probe.model.contextLength},
		{field: 'model.embeddingLength', expected: environment.model.embeddingLength, observed: probe.model.embeddingLength},
		{field: 'model.generation.temperature', expected: environment.model.generation.temperature, observed: probe.model.generation.temperature},
		{field: 'model.generation.topP', expected: environment.model.generation.topP, observed: probe.model.generation.topP},
		{field: 'model.generation.topK', expected: environment.model.generation.topK, observed: probe.model.generation.topK},
		{field: 'model.generation.repeatPenalty', expected: environment.model.generation.repeatPenalty, observed: probe.model.generation.repeatPenalty},
		{field: 'model.generation.stop', expected: environment.model.generation.stop, observed: probe.model.generation.stop},
	];

	return checks
		.filter((check) => JSON.stringify(check.expected) !== JSON.stringify(check.observed))
		.map((check) => difference(check.field, check.expected, check.observed));
};

/**
 * Builds a manifest from measured facts.
 *
 * @param input - Identity, purpose, reference machine, timestamp, and probe.
 * @returns A validated environment manifest.
 */
export const capturedEnvironmentOf = (
	input: Readonly<{
		id: string;
		purpose: EnvironmentPurposeType;
		referenceMachine: string;
		recordedAt: string;
		probe: EnvironmentProbeType;
	}>,
): EnvironmentManifestType =>
	environmentManifestOf({
		schemaVersion: ENVIRONMENT_SCHEMA_VERSION,
		id: input.id,
		purpose: input.purpose,
		recordedAt: input.recordedAt,
		host: {...input.probe.host, referenceMachine: input.referenceMachine},
		runtime: input.probe.runtime,
		model: input.probe.model,
	});

/**
 * Limits the environment to the declared model.
 *
 * @param environment - Validated environment manifest.
 * @param model - Suite model reference.
 */
export const assertEnvironmentModel = (environment: EnvironmentManifestType, model: string): void => {
	if (environment.model.reference !== model) {
		throw new Error(`environment pins "${environment.model.reference}" but the suite declares "${model}"`);
	}
};

/**
 * Requires a manifest to be declared for the command that loads it.
 *
 * A smoke manifest and a calibration manifest describe different obligations,
 * so neither may silently stand in for the other.
 *
 * @param environment - Validated environment manifest.
 * @param purpose - Purpose required by the command.
 */
export const assertEnvironmentPurpose = (environment: EnvironmentManifestType, purpose: EnvironmentPurposeType): void => {
	if (environment.purpose !== purpose) {
		throw new Error(`environment ${environment.id} declares purpose "${environment.purpose}", not "${purpose}"`);
	}
};

/**
 * Requires the measured facts to equal the pinned environment.
 *
 * @param environment - Committed environment manifest.
 * @param probe - Facts measured before the smoke run.
 */
export const assertEnvironmentMatches = (environment: EnvironmentManifestType, probe: EnvironmentProbeType): void => {
	const differences = environmentDifferencesOf(environment, probe);

	if (differences.length > 0) {
		const detail = differences.map((item) => `${item.field}: pinned ${item.expected}, measured ${item.observed}`).join('\n');
		throw new Error(`local environment does not match ${environment.id}:\n${detail}`);
	}
};
