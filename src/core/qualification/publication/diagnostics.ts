import {type PublicationViolationExampleType} from './invariants.ts';
import {type PublicationDiagnosticArtifactType, type R2ReportType} from './types.ts';

/**
 * Creates the bounded local diagnostic artifact for measured violations.
 *
 * The artifact may contain workspace-relative paths, offsets, and opaque IDs.
 * It never contains source text, query text, credentials, or absolute paths.
 *
 * @param input - Project identity, violation summaries, examples, and truncation state.
 * @returns Grouped diagnostic artifact.
 */
export const createPublicationDiagnostics = (
	input: Readonly<{
		readonly projectId: string;
		readonly contexts: readonly string[];
		readonly r2: R2ReportType;
		readonly examples: readonly PublicationViolationExampleType[];
		readonly truncated: boolean;
	}>,
): PublicationDiagnosticArtifactType => {
	const groups: PublicationDiagnosticArtifactType['groups'][number][] = [];
	let {truncated} = input;

	for (const [invariant, summary] of [
		['S3', input.r2.s3],
		['O2', input.r2.o2],
		['L1', input.r2.l1],
		['F1', input.r2.f1],
	] as const) {
		for (const [violationClass, count] of Object.entries(summary.classes)) {
			const matching = input.examples.filter((example) => example.invariant === invariant && example.class === violationClass);

			if (matching.length < count) {
				truncated = true;
			}

			groups.push({
				invariant,
				class: violationClass,
				examples: matching.slice(0, 20),
				count,
			});
		}
	}

	return {
		schemaVersion: 1,
		projectId: input.projectId,
		contexts: input.contexts,
		groups,
		truncated,
	};
};
