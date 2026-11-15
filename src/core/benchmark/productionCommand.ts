import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {CommandExitError, configureCommand} from '../../transports/cli/commanderSupport.ts';
import {type BenchmarkIoType} from './finalize.ts';
import {compareProductionBenchmarkReports, type ProductionBenchmarkComparisonType} from './productionComparison.ts';
import {loadProductionBenchmarkManifest, loadProductionBenchmarkReport} from './productionContract.ts';

type ProductionComparisonValuesType = Readonly<{
	manifest: string;
	control: string;
	candidate: string;
	output: string;
}>;

/**
 * Validates retained production evidence and writes its control/candidate comparison.
 *
 * @param input - Paths resolved relative to the caller's working directory.
 * @returns Comparison with a failing status when semantic digests drift.
 */
export const runProductionBenchmarkComparison = (
	input: Readonly<{values: ProductionComparisonValuesType; cwd: string; io: BenchmarkIoType}>,
): ProductionBenchmarkComparisonType => {
	const manifest = loadProductionBenchmarkManifest(path.resolve(input.cwd, input.values.manifest));
	const control = loadProductionBenchmarkReport(path.resolve(input.cwd, input.values.control));
	const candidate = loadProductionBenchmarkReport(path.resolve(input.cwd, input.values.candidate));
	const comparison = compareProductionBenchmarkReports(manifest, control, candidate);
	const outputPath = path.resolve(input.cwd, input.values.output);

	mkdirSync(path.dirname(outputPath), {recursive: true});
	writeFileSync(outputPath, `${JSON.stringify(comparison, null, '\t')}\n`, {encoding: 'utf8'});
	input.io.stdout(`Production benchmark comparison: ${comparison.status}`);
	input.io.stdout(`Semantic mismatches: ${String(comparison.semanticMismatches)}`);
	input.io.stdout(`Comparison written to ${outputPath}`);

	return comparison;
};

const commandOf = (io: BenchmarkIoType, cwd: string): Command =>
	configureCommand(
		new Command('benchmark-production-compare')
			.description('Validate and compare frozen production-scale control and candidate benchmark reports')
			.requiredOption('--manifest <path>', 'frozen production benchmark manifest')
			.requiredOption('--control <path>', 'development-checkout control report')
			.requiredOption('--candidate <path>', 'candidate report')
			.requiredOption('--output <path>', 'comparison JSON path'),
		io,
	).action((values: ProductionComparisonValuesType) => {
		const comparison = runProductionBenchmarkComparison({values, cwd, io});

		if (comparison.status === 'failure') {
			throw new CommandExitError(1);
		}
	});

/**
 * Registers the retained production benchmark comparison command.
 *
 * @param program - Root CLI program.
 * @param io - Output sinks.
 * @param cwd - Base directory for report paths.
 */
export const addProductionBenchmarkComparisonCommand = (program: Command, io: BenchmarkIoType, cwd: string = process.cwd()): void => {
	program.addCommand(commandOf(io, cwd));
};
