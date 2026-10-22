import {type GenerationSettingsType, type HostEnvironmentType, type ModelEnvironmentType, type RuntimeEnvironmentType} from './environment.ts';

export const ENVIRONMENT_KEYS = new Set(['schemaVersion', 'id', 'purpose', 'recordedAt', 'host', 'runtime', 'model']);
export const HOST_KEYS = new Set(['referenceMachine', 'nodeVersion', 'platform', 'arch', 'cpuModel', 'cpuCount', 'memoryBytes', 'osVersion']);
export const RUNTIME_KEYS = new Set(['ollama', 'opencode', 'ollamaEndpoint']);
export const MODEL_KEYS = new Set(['reference', 'digest', 'architecture', 'parameters', 'quantization', 'contextLength', 'embeddingLength', 'generation']);
export const GENERATION_KEYS = new Set(['temperature', 'topP', 'topK', 'repeatPenalty', 'stop']);

const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const rejectUnknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void => {
	const unknown = Object.keys(value)
		.filter((key) => !allowed.has(key))
		.sort();

	if (unknown.length > 0) {
		throw new Error(`${context} has unknown field(s): ${unknown.join(', ')}`);
	}
};

export const requireObject = (value: unknown, context: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new Error(`${context} must be a JSON object`);
	}

	return value;
};

export const requireString = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${context} field "${field}" must be a non-empty string`);
	}

	return value;
};

export const requireStableId = (value: unknown, field: string, context: string): string => {
	const id = requireString(value, field, context);

	if (!STABLE_ID.test(id)) {
		throw new Error(`${context} field "${field}" must match ${STABLE_ID}`);
	}

	return id;
};

export const requireHexDigest = (value: unknown, field: string, context: string): string => {
	if (typeof value !== 'string' || !HEX_DIGEST.test(value)) {
		throw new Error(`${context} field "${field}" must be a 64-character lowercase hex digest`);
	}

	return value;
};

export const requirePositiveInteger = (value: unknown, field: string, context: string): number => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${context} field "${field}" must be a positive integer`);
	}

	return value;
};

export const requireNonNegativeNumber = (value: unknown, field: string, context: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`${context} field "${field}" must be a non-negative number`);
	}

	return value;
};

export const optionalNonNegativeNumber = (value: unknown, field: string, context: string): number | null =>
	value === null ? null : requireNonNegativeNumber(value, field, context);

export const optionalPositiveInteger = (value: unknown, field: string, context: string): number | null =>
	value === null ? null : requirePositiveInteger(value, field, context);

export const requireStringArray = (value: unknown, field: string, context: string): readonly string[] => {
	if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string' && item.length > 0)) {
		throw new Error(`${context} field "${field}" must be an array of non-empty strings`);
	}

	return value;
};

export const hostOf = (value: unknown): HostEnvironmentType => {
	const record = requireObject(value, 'environment field "host"');
	rejectUnknownKeys(record, HOST_KEYS, 'environment field "host"');

	return {
		referenceMachine: requireString(record.referenceMachine, 'host.referenceMachine', 'environment'),
		nodeVersion: requireString(record.nodeVersion, 'host.nodeVersion', 'environment'),
		platform: requireString(record.platform, 'host.platform', 'environment'),
		arch: requireString(record.arch, 'host.arch', 'environment'),
		cpuModel: requireString(record.cpuModel, 'host.cpuModel', 'environment'),
		cpuCount: requirePositiveInteger(record.cpuCount, 'host.cpuCount', 'environment'),
		memoryBytes: requirePositiveInteger(record.memoryBytes, 'host.memoryBytes', 'environment'),
		osVersion: requireString(record.osVersion, 'host.osVersion', 'environment'),
	};
};

export const runtimeOf = (value: unknown): RuntimeEnvironmentType => {
	const record = requireObject(value, 'environment field "runtime"');
	rejectUnknownKeys(record, RUNTIME_KEYS, 'environment field "runtime"');

	return {
		ollama: requireString(record.ollama, 'runtime.ollama', 'environment'),
		opencode: requireString(record.opencode, 'runtime.opencode', 'environment'),
		ollamaEndpoint: requireString(record.ollamaEndpoint, 'runtime.ollamaEndpoint', 'environment'),
	};
};

export const generationOf = (value: unknown): GenerationSettingsType => {
	const record = requireObject(value, 'environment field "model.generation"');
	rejectUnknownKeys(record, GENERATION_KEYS, 'environment field "model.generation"');

	return {
		temperature: optionalNonNegativeNumber(record.temperature, 'model.generation.temperature', 'environment'),
		topP: optionalNonNegativeNumber(record.topP, 'model.generation.topP', 'environment'),
		topK: optionalPositiveInteger(record.topK, 'model.generation.topK', 'environment'),
		repeatPenalty: optionalNonNegativeNumber(record.repeatPenalty, 'model.generation.repeatPenalty', 'environment'),
		stop: requireStringArray(record.stop, 'model.generation.stop', 'environment'),
	};
};

export const modelOf = (value: unknown): ModelEnvironmentType => {
	const record = requireObject(value, 'environment field "model"');
	rejectUnknownKeys(record, MODEL_KEYS, 'environment field "model"');

	return {
		reference: requireString(record.reference, 'model.reference', 'environment'),
		digest: requireHexDigest(record.digest, 'model.digest', 'environment'),
		architecture: requireString(record.architecture, 'model.architecture', 'environment'),
		parameters: requireString(record.parameters, 'model.parameters', 'environment'),
		quantization: requireString(record.quantization, 'model.quantization', 'environment'),
		contextLength: requirePositiveInteger(record.contextLength, 'model.contextLength', 'environment'),
		embeddingLength: requirePositiveInteger(record.embeddingLength, 'model.embeddingLength', 'environment'),
		generation: generationOf(record.generation),
	};
};
