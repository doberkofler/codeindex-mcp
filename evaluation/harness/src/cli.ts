import {calibrationCommand} from './cliCalibration.ts';
import {certifyCommand} from './cliCertify.ts';
import {environmentCommand, smokeCommand} from './cliEnvironment.ts';
import {evaluateCommand} from './cliEvaluate.ts';
import {localDiagnosticCommand, localRegressionCommand} from './cliLocal.ts';
import {pilotCommand} from './cliPilot.ts';
import {preflightCommand} from './cliPreflight.ts';
import {qualificationCommand} from './cliQualification.ts';
import {releaseCommand} from './cliRelease.ts';
import {checkCommand, listCommand, reportCommand} from './cliReport.ts';
import {routeCommand} from './cliRoute.ts';
import {validityCommand} from './cliValidity.ts';
import {argsOf} from './cliSupport.ts';

const {command, flags} = argsOf(process.argv.slice(2));

try {
	if (command === 'evaluate') {
		await evaluateCommand(flags);
	} else if (command === 'smoke') {
		await smokeCommand(flags);
	} else if (command === 'calibrate') {
		await calibrationCommand(flags);
	} else if (command === 'local-diagnostic') {
		await localDiagnosticCommand(flags);
	} else if (command === 'local-regression') {
		await localRegressionCommand(flags);
	} else if (command === 'qualification') {
		await qualificationCommand(flags);
	} else if (command === 'release') {
		await releaseCommand(flags);
	} else if (command === 'validity') {
		await validityCommand(flags);
	} else if (command === 'pilot') {
		await pilotCommand(flags);
	} else if (command === 'certify') {
		await certifyCommand(flags);
	} else if (command === 'environment') {
		await environmentCommand(flags);
	} else if (command === 'route') {
		await routeCommand(flags);
	} else if (command === 'preflight') {
		await preflightCommand(flags);
	} else if (command === 'report') {
		reportCommand(flags);
	} else if (command === 'check') {
		checkCommand(flags);
	} else if (command === 'list') {
		listCommand(flags);
	} else {
		process.stdout.write(
			'usage: cli.ts <evaluate|smoke|calibrate|local-diagnostic|local-regression|qualification|release|validity|pilot|certify|environment|route|preflight|report|check|list> --suite <path> [--design <path>] [--environment <path>] [--canonical <manifest>] [--hosted-reference <path>] [--model-free <report>] [--provider-upstream url] [--provider-auth-env name] [--aa-case id] [--aa-repetitions n] [--smoke-case id] [--target-metric retrievalBytes|toolCalls|tokens|wallTimeMs] [--exclude id=reason] [--budget-ms n] [--plan <path>] [--case id] [--tag tag] [--treatment all|no-index|accepted|candidate|canonical] [--repetitions n] [--dry-run] [--resume] [--retry-timed-out] [--campaign-store path] [--output dir]\n',
		);
		process.exitCode = command === 'help' ? 0 : 2;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
