import {calibrationCommand} from './cliCalibration.ts';
import {environmentCommand, smokeCommand} from './cliEnvironment.ts';
import {evaluateCommand} from './cliEvaluate.ts';
import {localDiagnosticCommand, localRegressionCommand} from './cliLocal.ts';
import {checkCommand, listCommand, reportCommand} from './cliReport.ts';
import {routeCommand} from './cliRoute.ts';
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
	} else if (command === 'environment') {
		await environmentCommand(flags);
	} else if (command === 'route') {
		await routeCommand(flags);
	} else if (command === 'report') {
		reportCommand(flags);
	} else if (command === 'check') {
		checkCommand(flags);
	} else if (command === 'list') {
		listCommand(flags);
	} else {
		process.stdout.write(
			'usage: cli.ts <evaluate|smoke|calibrate|local-diagnostic|local-regression|environment|route|report|check|list> --suite <path> [--environment <path>] [--target-metric retrievalBytes|toolCalls|tokens|wallTimeMs] [--exclude id=reason] [--budget-ms n] [--plan <path>] [--case id] [--tag tag] [--treatment all|no-index|accepted|candidate] [--repetitions n] [--dry-run] [--resume] [--campaign-store path] [--output dir]\n',
		);
		process.exitCode = command === 'help' ? 0 : 2;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
