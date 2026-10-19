import {createHash} from 'node:crypto';

/**
 * Creates a deterministic Oracle symbol or dependency identifier.
 *
 * Identity depends on the indexed project, source location, kind, and name so
 * repeated builds produce byte-identical fact ordering and identifiers.
 *
 * @param input - Identity inputs.
 * @returns A 32-character hexadecimal identifier.
 */
export const createOracleId = (
	input: Readonly<{
		projectId: string;
		path: string;
		startOffset: number;
		kind: string;
		name: string;
		discriminator?: string;
	}>,
): string =>
	createHash('sha256')
		.update([input.projectId, input.path, String(input.startOffset), input.kind, input.name, input.discriminator ?? ''].join('\u0000'))
		.digest('hex')
		.slice(0, 32);
