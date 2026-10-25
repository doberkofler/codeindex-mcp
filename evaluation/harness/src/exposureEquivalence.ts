import {type TreatmentDefinitionType} from './treatment.ts';

const sameArtifactOf = (direct: TreatmentDefinitionType, wrapped: TreatmentDefinitionType): boolean => {
	const directArtifact = direct.artifact;
	const wrappedArtifact = wrapped.artifact;

	return (
		directArtifact !== null &&
		wrappedArtifact !== null &&
		directArtifact.id === wrappedArtifact.id &&
		directArtifact.root === wrappedArtifact.root &&
		directArtifact.entryPoint === wrappedArtifact.entryPoint &&
		directArtifact.digest === wrappedArtifact.digest
	);
};

/**
 * Describes the deliberate and accidental differences of the exposure pair.
 *
 * @param treatments - Validated treatment definitions in the exposure set.
 * @returns Human-readable differences; empty when only Code Mode differs.
 */
export const exposureDifferencesOf = (treatments: readonly TreatmentDefinitionType[]): readonly string[] => {
	const direct = treatments.find((treatment) => treatment.id === 'direct-mcp');
	const wrapped = treatments.find((treatment) => treatment.id === 'code-mode');

	if (direct === undefined || wrapped === undefined) {
		return [];
	}

	const differences: string[] = [];

	if (direct.mcp?.server !== wrapped.mcp?.server) {
		differences.push(`MCP server differs between ${direct.id} and ${wrapped.id}`);
	}

	if (direct.codeMode !== 'absent' || direct.mcp?.codemode !== false) {
		differences.push('direct-mcp treatment must present native MCP tools directly');
	}

	if (wrapped.codeMode !== 'present' || wrapped.mcp?.codemode !== true) {
		differences.push('code-mode treatment must present the artifact through Code Mode');
	}

	if (!sameArtifactOf(direct, wrapped)) {
		differences.push('the direct and Code Mode arms must load the same artifact');
	}

	return differences;
};
