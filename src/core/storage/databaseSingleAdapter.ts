import {type DatabaseSync} from 'node:sqlite';
import {type GenerationFactsInputType} from './databaseFactTypes.ts';
import {type AdapterCommitCountsType, type AdapterCommitType, type GenerationCommitInputType} from './databaseCommitTypes.ts';
import {readGeneration} from './databaseRead.ts';
import {asNumber} from './databaseRows.ts';

const adapterRowCounts = (row: Readonly<Record<string, unknown>>): AdapterCommitCountsType => ({
	files: asNumber(row, 'file_count'),
	symbols: asNumber(row, 'symbol_count'),
	occurrences: asNumber(row, 'occurrence_count'),
	dependencyEdges: asNumber(row, 'dependency_edge_count'),
	dependencyBindings: asNumber(row, 'dependency_binding_count'),
	diagnostics: asNumber(row, 'diagnostic_count'),
});

/**
 * Projects a legacy singular commit onto one multi-adapter contribution.
 *
 * @param writer - Writer connection.
 * @param input - Singular commit.
 * @returns Equivalent adapter contribution.
 */
export const adapterFromSingle = (writer: DatabaseSync, input: GenerationCommitInputType): AdapterCommitType => {
	const generation = readGeneration(writer, input.generationId);

	if (generation === null) {
		throw new Error('Generation disappeared before commit');
	}

	const factsInput = input.reuseFacts ? null : (input as GenerationFactsInputType & Readonly<{reuseFacts: false}>);
	const {provenance} = input;
	const {adapterId} = provenance;
	const previousRow = writer.prepare('select * from generation_adapter where generation_id = ? and adapter_id = ?').get(input.generationId, adapterId);
	const counts =
		previousRow === undefined
			? {
					files: generation.fileCount,
					symbols: generation.symbolCount,
					occurrences: generation.occurrenceCount,
					dependencyEdges: generation.dependencyEdgeCount,
					dependencyBindings: generation.dependencyBindingCount,
					diagnostics: generation.diagnosticCount,
				}
			: adapterRowCounts(previousRow);

	return {
		adapterId,
		protocolVersion: provenance.protocolVersion,
		adapterVersion: provenance.adapterVersion,
		packageName: provenance.packageName,
		packageVersion: provenance.packageVersion,
		compilerVersion: provenance.compilerVersion,
		declaredCompilerVersion: input.declaredCompilerVersion ?? provenance.declaredCompilerVersion,
		compilerDrift: input.compilerDrift ?? provenance.compilerDrift,
		coverage: 'present',
		absenceReason: null,
		sourceHash: input.sourceHash,
		configHash: input.configHash,
		inputHash: input.inputHash ?? input.configHash,
		counts,
		stages: input.stages,
		files: input.files,
		projects: input.projects,
		...(factsInput === null
			? {}
			: {
					facts: factsInput.facts,
					dependencies: factsInput.dependencies,
					diagnostics: factsInput.diagnostics,
				}),
	};
};
