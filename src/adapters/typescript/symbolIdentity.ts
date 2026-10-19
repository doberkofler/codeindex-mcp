import {createHash} from 'node:crypto';

/**
 * Creates a deterministic symbol identifier for one generation.
 *
 * The identity intentionally depends on declaration position: moving a
 * declaration changes its identifier. Persistent cross-generation identities are
 * deferred until the prototype proves useful.
 *
 * @param input - Declaration identity inputs.
 * @param input.discriminator - Optional context discriminator for location-keyed
 * facts that must remain distinct per project context, such as dependency edges.
 * @returns A 32-character hexadecimal identifier.
 */
export const createSymbolId = (
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
