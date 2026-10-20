import {type IndexedSymbolType} from '../../core/model.ts';
import {type CandidateInputType, type CandidateType} from './publicationCandidateTypes.ts';
import {createSymbolId} from './symbolIdentity.ts';

/**
 * Creates the persisted symbol record for one candidate.
 *
 * @param input - Candidate collection input.
 * @param candidate - Candidate declaration.
 * @returns Indexed symbol with deterministic identity and primary extent.
 */
export const candidateSymbolOf = (input: CandidateInputType, candidate: CandidateType): IndexedSymbolType => ({
	id: createSymbolId({
		projectId: input.projectId,
		path: candidate.path,
		startOffset: candidate.primary.range.startOffset,
		kind: candidate.kind,
		name: candidate.name,
	}),
	name: candidate.name,
	qualifiedName: candidate.name,
	kind: candidate.kind,
	path: candidate.path,
	startLine: candidate.primary.extent.startLine,
	startColumn: candidate.primary.extent.startColumn,
	endLine: candidate.primary.extent.endLine,
	endColumn: candidate.primary.extent.endColumn,
	startOffset: candidate.primary.extent.startOffset,
	endOffset: candidate.primary.extent.endOffset,
	enclosingId: null,
	externalTarget: candidate.externalTarget,
	externalName: candidate.externalName,
	contexts: [input.context],
});
