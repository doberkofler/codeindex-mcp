import {loadConfig} from '../../config/config.ts';
import {debugFor} from '../../logging/debug.ts';
import {type ReferenceVerificationReportType} from '@codeindex/adapter-typescript/referenceGate';
import {verifyTypeScriptReferences as verifyWithRunner} from '@codeindex/adapter-typescript/verifyReferences';
import {withPersistedReferenceIndex} from './referencePersistence.ts';

const debug = debugFor('verify');

const boundedMessage = (error: unknown, rootDir: string): string => {
	const message = error instanceof Error ? error.message : String(error);

	return message.split(rootDir).join('<root>').slice(0, 500);
};

/**
 * Runs reference verification through the TypeScript adapter.
 *
 * @param config - Resolved host configuration.
 * @returns The aggregate verification report.
 */
export const verifyTypeScriptReferences = (config: Parameters<typeof verifyWithRunner>[0]): ReferenceVerificationReportType =>
	verifyWithRunner(config, withPersistedReferenceIndex);

/**
 * Runs reference verification and writes its JSON report to the supplied sink.
 *
 * @param environment - Environment source validated by `loadConfig`.
 * @param io - Output sinks.
 * @returns Process exit code: 0 only when the production gate passes.
 */
export const runVerification = (environment: NodeJS.ProcessEnv, io: Readonly<{stdout: (line: string) => void}>): number => {
	const config = loadConfig(environment);
	debug('verification start', {rootDir: config.rootDir, projectFiles: config.projects.map((project) => project.projectFilePath)});

	let report: ReferenceVerificationReportType;

	try {
		report = verifyTypeScriptReferences(config);
	} catch (error) {
		io.stdout(JSON.stringify({gate: {ok: false, failures: [{kind: 'verifier_exception', detail: boundedMessage(error, config.rootDir)}]}}, null, 2));

		return 1;
	}

	io.stdout(JSON.stringify(report, null, 2));
	return report.gate.ok ? 0 : 1;
};
