import assert from 'node:assert/strict';
import path from 'node:path';
import {describe, it} from 'vitest';
import {
	capturedEnvironmentOf,
	environmentDifferencesOf,
	environmentManifestOf,
	environmentProbeOf,
	type EnvironmentManifestType,
	type EnvironmentProbeType,
	type HostFactsType,
	loadEnvironmentManifest,
} from './environment.ts';
import {modelIdentityOf} from './identity.ts';
import {loadSuite} from './suite.ts';

const EVALUATION_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENVIRONMENT_PATH = path.join(EVALUATION_ROOT, 'environments', 'ollama-qwen3-8b-smoke.json');
const QWEN_27B_PATH = path.join(EVALUATION_ROOT, 'environments', 'ollama-qwen3.8-27b-calibration.json');
const QWEN_35B_PATH = path.join(EVALUATION_ROOT, 'environments', 'ollama-qwen3.6-35b-calibration.json');
const DEVSTRAL_PATH = path.join(EVALUATION_ROOT, 'environments', 'ollama-devstral-small-2-calibration.json');
const CALIBRATION_PATH = path.join(EVALUATION_ROOT, 'suites', 'calibration.json');
const DIGEST = '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41';

const host: HostFactsType = {
	nodeVersion: 'v26.10.0',
	platform: 'darwin',
	arch: 'arm64',
	cpuModel: 'Apple M5 Max',
	cpuCount: 18,
	memoryBytes: 68_719_476_736,
	osVersion: 'Darwin Kernel Version 27.0.0: Tue Aug 11 21:06:40 PDT 2026; root:xnu-13432.1.9~1/RELEASE_ARM64_T6050',
};

const manifest = (): EnvironmentManifestType =>
	environmentManifestOf({
		schemaVersion: 1,
		id: 'ollama-qwen3-8b-smoke',
		purpose: 'smoke',
		recordedAt: '2026-10-21T21:14:18.000Z',
		host: {...host, referenceMachine: 'apple-m5-max-64gb'},
		runtime: {ollama: '0.40.7', opencode: '2.1.2', ollamaEndpoint: 'http://127.0.0.1:11434'},
		model: {
			reference: 'ollama/qwen3:8b',
			digest: DIGEST,
			architecture: 'qwen3',
			parameters: '8.2B',
			quantization: 'Q4_K_M',
			contextLength: 40_960,
			embeddingLength: 4096,
			generation: {temperature: 0.6, topP: 0.95, topK: 20, repeatPenalty: 1, stop: ['<|im_start|>', '<|im_end|>']},
		},
	});

const probe = (): EnvironmentProbeType => ({
	host,
	runtime: {ollama: '0.40.7', opencode: '2.1.2', ollamaEndpoint: 'http://127.0.0.1:11434'},
	model: manifest().model,
});

describe('environment', () => {
	it('committed smoke environment pins the calibration model and full identity', () => {
		const environment = loadEnvironmentManifest(ENVIRONMENT_PATH);
		const {suite} = loadSuite(CALIBRATION_PATH);

		assert.equal(environment.purpose, 'smoke');
		assert.equal(environment.model.reference, suite.model);
		assert.match(environment.model.digest, /^[0-9a-f]{64}$/u);
		assert.equal(environment.runtime.ollamaEndpoint, 'http://127.0.0.1:11434');
		assert.deepEqual(environmentDifferencesOf(environment, probe()), []);
	});

	it('committed calibration environment pins the candidate model and settings', () => {
		const qwen27b = loadEnvironmentManifest(QWEN_27B_PATH);
		const qwen35b = loadEnvironmentManifest(QWEN_35B_PATH);
		const devstral = loadEnvironmentManifest(DEVSTRAL_PATH);

		assert.equal(devstral.purpose, 'calibration');
		assert.equal(devstral.model.reference, 'ollama/devstral-small-2:latest');
		assert.equal(devstral.model.digest, '24277f07f62db8f9cb68e9dfc679ea1818a7fbac47a50eff0a701d3f645b63c8');
		assert.equal(devstral.model.quantization, 'Q4_K_M');
		assert.equal(devstral.model.contextLength, 393_216);
		assert.deepEqual(devstral.model.generation, {temperature: 0.15, topP: null, topK: null, repeatPenalty: null, stop: []});
		assert.equal(devstral.runtime.ollama, '0.40.8');
		assert.equal(qwen27b.purpose, 'calibration');
		assert.equal(qwen27b.model.reference, 'ollama/qwen3.8:27b-mlx');
		assert.equal(qwen27b.model.digest, '5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e');
		assert.equal(qwen27b.model.quantization, 'nvfp4');
		assert.equal(qwen27b.model.contextLength, 262_144);
		assert.equal(qwen27b.runtime.ollama, '0.40.8');
		assert.equal(qwen35b.purpose, 'calibration');
		assert.equal(qwen35b.model.reference, 'ollama/qwen3.6:35b-mlx');
		assert.equal(qwen35b.model.digest, 'e92a3e94bbca90a85491dc34e9257bfee2318cedaa16360828c4d8edf14295b9');
		assert.equal(qwen35b.model.quantization, 'nvfp4');
		assert.equal(qwen35b.model.contextLength, 262_144);
		assert.equal(qwen35b.runtime.ollama, '0.40.7');
	});

	it('environment rejects missing facts instead of defaulting them', () => {
		const valid = manifest();
		const withoutGeneration = Object.fromEntries(Object.entries(valid.model).filter(([key]) => key !== 'generation'));

		assert.throws(() => environmentManifestOf({...valid, purpose: 'regression'}), /purpose/u);
		assert.equal(environmentManifestOf({...valid, purpose: 'calibration'}).purpose, 'calibration');
		assert.throws(() => environmentManifestOf({...valid, model: withoutGeneration}), /model.generation/u);
		assert.throws(() => environmentManifestOf({...valid, model: {...valid.model, digest: DIGEST.slice(0, 12)}}), /digest/u);
		assert.throws(() => environmentManifestOf({...valid, host: {...valid.host, memoryBytes: 0}}), /memoryBytes/u);
		assert.throws(() => environmentManifestOf({...valid, unexpected: true}), /unknown field/u);
	});

	it('capture derives the manifest from measured facts', () => {
		const captured = capturedEnvironmentOf({
			id: 'ollama-qwen3-8b-smoke',
			purpose: 'smoke',
			referenceMachine: 'apple-m5-max-64gb',
			recordedAt: '2026-10-21T21:14:18.000Z',
			probe: probe(),
		});

		assert.deepEqual(captured, manifest());
	});

	it('a model that declares only temperature pins the absent settings as null', async () => {
		const tags = {models: [{name: 'devstral-small-2:latest', digest: 'b'.repeat(64)}]};
		const show = {
			parameters: 'temperature                    0.15',
			details: {parameter_size: '24.0B', quantization_level: 'Q4_K_M'},
			model_info: {'general.architecture': 'mistral3', 'mistral3.context_length': 393_216, 'mistral3.embedding_length': 5120},
		};
		const measured = await environmentProbeOf({
			model: 'ollama/devstral-small-2:latest',
			host,
			command: (command) => (command === 'ollama' ? 'ollama version is 0.40.7' : '2.1.2'),
			fetchJson: (url) => (url.endsWith('/api/tags') ? tags : show),
		});

		assert.deepEqual(measured.model.generation, {temperature: 0.15, topP: null, topK: null, repeatPenalty: null, stop: []});
	});

	it('probe reads runtime versions and model facts from the provider', async () => {
		const tags = {models: [{name: 'qwen3:8b', digest: DIGEST}]};
		const show = {
			parameters: 'repeat_penalty 1\nstop "<|im_start|>"\nstop "<|im_end|>"\ntemperature 0.6\ntop_k 20\ntop_p 0.95',
			details: {parameter_size: '8.2B', quantization_level: 'Q4_K_M'},
			model_info: {'general.architecture': 'qwen3', 'qwen3.context_length': 40_960, 'qwen3.embedding_length': 4096},
		};
		const measured = await environmentProbeOf({
			model: 'ollama/qwen3:8b',
			endpoint: 'http://127.0.0.1:11434',
			host,
			command: (command) => (command === 'ollama' ? 'ollama version is 0.40.7' : '2.1.2'),
			fetchJson: (url) => (url.endsWith('/api/tags') ? tags : show),
		});

		assert.deepEqual(measured, probe());
	});

	it('environment differences name every changed fact', () => {
		const changed: EnvironmentProbeType = {
			host: {...host, nodeVersion: 'v27.0.0'},
			runtime: {...probe().runtime, opencode: '2.2.0'},
			model: {...probe().model, digest: 'a'.repeat(64), generation: {...probe().model.generation, temperature: 0.2}},
		};
		const differences = environmentDifferencesOf(manifest(), changed);

		assert.deepEqual(
			differences.map((item) => item.field),
			['host.nodeVersion', 'runtime.opencode', 'model.digest', 'model.generation.temperature'],
		);
	});

	it('model identity uses the pinned digest, quantization, runtime, and settings', () => {
		const identity = modelIdentityOf('ollama/qwen3:8b', manifest());

		assert.equal(identity.provider, 'ollama');
		assert.equal(identity.modelId, 'qwen3:8b');
		assert.equal(identity.digest, DIGEST);
		assert.equal(identity.quantization, 'Q4_K_M');
		assert.equal(identity.runtime, 'ollama');
		assert.equal(identity.runtimeVersion, '0.40.7');
		assert.notEqual(identity.generationSettingsDigest, modelIdentityOf('ollama/qwen3:8b').generationSettingsDigest);
		assert.throws(() => modelIdentityOf('ollama/other:8b', manifest()), /environment pins/u);
	});
});
