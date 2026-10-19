import {type BenchmarkBaselineType, type BenchmarkReferenceType} from './baseline.ts';
import {type BenchmarkReportType} from './benchTypes.ts';
import {benchmarkCorpusCounts} from './corpus.ts';
import {type BenchmarkGateType} from './evaluationTypes.ts';
import {driftGate, gate, skipped} from './gates.ts';

const corpusCountGates = (report: BenchmarkReportType, baseline: BenchmarkBaselineType): readonly BenchmarkGateType[] => {
	if (report.workspace.kind !== 'generated' || report.workspace.profile === null) {
		return [];
	}

	const expected = benchmarkCorpusCounts(report.workspace.profile);

	return [
		driftGate({
			code: 'compatibility.file_count',
			message: 'Corpus file count drift',
			current: report.workspace.fileCount,
			reference: expected.fileCount,
			tolerance: baseline.compatibility.fileCountToleranceRatio,
		}),
		driftGate({
			code: 'compatibility.symbol_count',
			message: 'Corpus symbol count drift',
			current: report.workspace.symbolCount,
			reference: expected.symbolCount,
			tolerance: baseline.compatibility.symbolCountToleranceRatio,
		}),
	];
};

const referenceCountGates = (report: BenchmarkReportType, reference: BenchmarkReferenceType, baseline: BenchmarkBaselineType): readonly BenchmarkGateType[] => {
	if (report.workspace.kind === 'generated' && report.workspace.profile !== null) {
		const expected = benchmarkCorpusCounts(report.workspace.profile);

		return [
			driftGate({
				code: 'compatibility.reference_file_count',
				message: 'Reference corpus file count drift',
				current: reference.workspace.fileCount,
				reference: expected.fileCount,
				tolerance: baseline.compatibility.fileCountToleranceRatio,
			}),
			driftGate({
				code: 'compatibility.reference_symbol_count',
				message: 'Reference corpus symbol count drift',
				current: reference.workspace.symbolCount,
				reference: expected.symbolCount,
				tolerance: baseline.compatibility.symbolCountToleranceRatio,
			}),
		];
	}

	return [
		driftGate({
			code: 'compatibility.file_count',
			message: 'Workspace file count drift',
			current: report.workspace.fileCount,
			reference: reference.workspace.fileCount,
			tolerance: baseline.compatibility.fileCountToleranceRatio,
		}),
		driftGate({
			code: 'compatibility.symbol_count',
			message: 'Workspace symbol count drift',
			current: report.workspace.symbolCount,
			reference: reference.workspace.symbolCount,
			tolerance: baseline.compatibility.symbolCountToleranceRatio,
		}),
	];
};

const referenceCompatibilityGates = (
	report: BenchmarkReportType,
	reference: BenchmarkReferenceType,
	baseline: BenchmarkBaselineType,
): readonly BenchmarkGateType[] => {
	const machineMatches =
		reference.machine.platform === report.machine.platform &&
		reference.machine.arch === report.machine.arch &&
		reference.machine.cpuModel === report.machine.cpuModel;
	const gates: BenchmarkGateType[] = [
		gate(reference.reportSchemaVersion === report.schemaVersion ? 'pass' : 'failure', 'compatibility.reference_schema', 'compatibility', {
			message: 'Reference report schema must match the current report',
			actual: reference.reportSchemaVersion,
			expected: report.schemaVersion,
		}),
		gate(reference.workspace.kind === report.workspace.kind ? 'pass' : 'failure', 'compatibility.reference_workspace_kind', 'compatibility', {
			message: 'Reference workspace kind must match the current workspace',
			actual: reference.workspace.kind,
			expected: report.workspace.kind,
		}),
		gate(reference.workspace.profile === report.workspace.profile ? 'pass' : 'failure', 'compatibility.reference_workspace_profile', 'compatibility', {
			message: 'Reference profile must match the current workspace',
			actual: reference.workspace.profile ?? 'null',
			expected: report.workspace.profile ?? 'null',
		}),
		gate(machineMatches ? 'pass' : 'warning', 'compatibility.machine', 'compatibility', {
			message: machineMatches ? 'Reference machine matches' : 'Reference machine differs; compare results cautiously',
			actual: `${report.machine.platform}/${report.machine.arch}`,
			expected: `${reference.machine.platform}/${reference.machine.arch}`,
		}),
	];

	for (const referenceScenario of reference.scenarios) {
		const current = report.scenarios.find((scenario) => scenario.name === referenceScenario.name);

		if (current !== undefined && current.kind !== referenceScenario.kind) {
			gates.push(
				gate('failure', `compatibility.reference_scenario.${referenceScenario.name}`, 'compatibility', {
					message: `Reference scenario ${referenceScenario.name} must have the same kind`,
					actual: current.kind,
					expected: referenceScenario.kind,
				}),
			);
		}
	}

	gates.push(...referenceCountGates(report, reference, baseline));

	return gates;
};

/**
 * Evaluates corpus identity and optional reference compatibility.
 *
 * Generated corpus counts are checked against deterministic profile
 * expectations, independently of any retained reference. A reference must
 * match the current schema, workspace identity, and corpus counts before its
 * relative measurements are usable.
 *
 * @param report - Completed benchmark report.
 * @param baseline - Parsed baseline thresholds and optional reference.
 * @returns Compatibility gates and whether relative gates may run.
 */
export const compatibilityGates = (
	report: BenchmarkReportType,
	baseline: BenchmarkBaselineType,
): Readonly<{gates: readonly BenchmarkGateType[]; referenceCompatible: boolean}> => {
	const gates: BenchmarkGateType[] = [];
	const {compatibility} = baseline;

	gates.push(
		gate(report.schemaVersion === baseline.reportSchemaVersion ? 'pass' : 'failure', 'compatibility.report_schema', 'compatibility', {
			message: 'Benchmark report schema must match the baseline',
			actual: report.schemaVersion,
			expected: baseline.reportSchemaVersion,
		}),
	);

	if (compatibility.workspaceKind !== null) {
		gates.push(
			gate(report.workspace.kind === compatibility.workspaceKind ? 'pass' : 'failure', 'compatibility.workspace_kind', 'compatibility', {
				message: 'Workspace kind must match the baseline',
				actual: report.workspace.kind,
				expected: compatibility.workspaceKind,
			}),
		);
	}

	if (compatibility.profile !== null) {
		gates.push(
			gate(report.workspace.profile === compatibility.profile ? 'pass' : 'failure', 'compatibility.workspace_profile', 'compatibility', {
				message: 'Generated profile must match the baseline',
				actual: report.workspace.profile ?? 'null',
				expected: compatibility.profile,
			}),
		);
	}

	const present = new Set(report.scenarios.map((scenario) => scenario.name));
	const missing = baseline.requiredScenarios.filter((name) => !present.has(name));

	gates.push(
		baseline.requiredScenarios.length === 0
			? skipped('compatibility.required_scenarios', 'No scenarios are required')
			: gate(missing.length === 0 ? 'pass' : 'failure', 'compatibility.required_scenarios', 'compatibility', {
					message: missing.length === 0 ? 'All required scenarios ran' : `Missing required scenarios: ${missing.join(', ')}`,
					actual: missing.length,
					expected: 0,
					unit: 'count',
				}),
	);

	const corpusGates = corpusCountGates(report, baseline);
	gates.push(...corpusGates);

	const {reference} = baseline;

	if (reference === null) {
		if (report.workspace.kind !== 'generated') {
			gates.push(
				skipped('compatibility.file_count', 'External workspace count drift requires a reference', 'compatibility'),
				skipped('compatibility.symbol_count', 'External workspace count drift requires a reference', 'compatibility'),
			);
		}

		gates.push(skipped('compatibility.reference', 'No reference measurements supplied; relative regression gates are skipped'));
		return {gates, referenceCompatible: true};
	}

	gates.push(gate('pass', 'compatibility.reference', 'compatibility', {message: 'Reference measurements are present'}));

	const referenceGates = referenceCompatibilityGates(report, reference, baseline);

	gates.push(...referenceGates);

	return {gates, referenceCompatible: referenceGates.every((entry) => entry.status !== 'failure')};
};
