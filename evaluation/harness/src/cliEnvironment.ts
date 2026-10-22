import path from 'node:path';
import {
	assertEnvironmentMatches,
	assertEnvironmentModel,
	assertEnvironmentPurpose,
	capturedEnvironmentOf,
	ENVIRONMENT_PURPOSES,
	environmentProbeOf,
	loadEnvironmentManifest,
} from './environment.ts';
import {writeJsonAtomic} from './result.ts';
import {loadSuite} from './suite.ts';
import {evaluateCommand} from './cliEvaluate.ts';
import {evaluationRoot, flagOf, manifestPathOf, verifiedEnvironmentOf} from './cliSupport.ts';

export const environmentCommand = async (flags: Map<string, string[]>): Promise<void> => {
	if (flags.has('capture')) {
		const environmentPath = manifestPathOf(flags, 'output');
		const model = flagOf(flags, 'model');
		const referenceMachine = flagOf(flags, 'reference-machine');
		const id = flagOf(flags, 'id');

		if (model === undefined || model === 'true') {
			throw new Error('--model is required');
		}

		if (referenceMachine === undefined || referenceMachine === 'true') {
			throw new Error('--reference-machine is required');
		}

		if (id === undefined || id === 'true') {
			throw new Error('--id is required');
		}

		const requestedPurpose = flagOf(flags, 'purpose') ?? 'smoke';
		const purpose = ENVIRONMENT_PURPOSES.find((item) => item === requestedPurpose);

		if (purpose === undefined) {
			throw new Error(`--purpose must be one of ${ENVIRONMENT_PURPOSES.join(', ')}`);
		}

		const probe = await environmentProbeOf({model, endpoint: flagOf(flags, 'endpoint') ?? 'http://127.0.0.1:11434'});
		const environment = capturedEnvironmentOf({
			id,
			purpose,
			referenceMachine,
			recordedAt: new Date().toISOString(),
			probe,
		});

		writeJsonAtomic(environmentPath, environment, false);
		process.stdout.write(`environment ${environment.id} written to ${environmentPath}\n`);
		process.stdout.write(
			`model ${environment.model.reference} ${environment.model.digest} ${environment.model.quantization} context ${environment.model.contextLength}\n`,
		);

		return;
	}

	const environment = loadEnvironmentManifest(manifestPathOf(flags, 'environment'));
	const probe = await environmentProbeOf({model: environment.model.reference, endpoint: environment.runtime.ollamaEndpoint});

	assertEnvironmentMatches(environment, probe);

	process.stdout.write(`environment ${environment.id} matches the measured host and model\n`);
	process.stdout.write(
		`model ${environment.model.reference} ${environment.model.digest} ${environment.model.quantization} context ${environment.model.contextLength}\n`,
	);
};

export const smokeCommand = async (flags: Map<string, string[]>): Promise<void> => {
	const requestedTreatment = flagOf(flags, 'treatment');
	const requestedRepetitions = flagOf(flags, 'repetitions');

	if (requestedTreatment !== undefined && requestedTreatment !== 'accepted') {
		throw new Error('smoke runs the accepted treatment only');
	}

	if (requestedRepetitions !== undefined && requestedRepetitions !== '1') {
		throw new Error('smoke runs one repetition only');
	}

	const suitePath = flagOf(flags, 'suite');

	if (suitePath === undefined || suitePath === 'true') {
		throw new Error('--suite is required');
	}

	const {suite} = loadSuite(path.resolve(evaluationRoot, suitePath));
	const environment = loadEnvironmentManifest(manifestPathOf(flags, 'environment'));

	assertEnvironmentPurpose(environment, 'smoke');
	assertEnvironmentModel(environment, suite.model);

	if (!flags.has('dry-run')) {
		process.stderr.write(`environment ${environment.id} verification\n`);
		await verifiedEnvironmentOf(environment);
	}

	process.stderr.write(`smoke ${suite.id} ${environment.model.reference} accepted only, one repetition\n`);
	await evaluateCommand(flags, {treatments: ['accepted'], repetitions: 1, environment, requireFrozen: true});
};
