import {existsSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {hashOf} from './hash.ts';

/** Input for resolving the mutable evaluation state root. */
export type StateRootInputType = Readonly<{
	/** Committed evaluation directory. */
	evaluationRoot: string;
	/** Primary checkout that must never contain mutable evaluation state. */
	primaryCheckout: string;
	environment?: NodeJS.ProcessEnv;
	/** Temporary directory override for deterministic tests. */
	temporaryDirectory?: string;
}>;

const insideOf = (parent: string, candidate: string): boolean => {
	const relative = path.relative(parent, candidate);

	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/**
 * Resolves symlinks in the longest existing prefix without requiring the leaf
 * to exist yet.
 *
 * @param candidate - Absolute path that may not be created.
 * @returns Canonical path of the existing prefix plus the remaining segments.
 */
const canonicalPathOf = (candidate: string): string => {
	const absolute = path.resolve(candidate);

	if (existsSync(absolute)) {
		return realpathSync(absolute);
	}

	let ancestor = path.dirname(absolute);

	while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
		ancestor = path.dirname(ancestor);
	}

	return path.join(realpathSync(ancestor), path.relative(ancestor, absolute));
};

/**
 * Rejects mutable evaluation state inside the primary checkout.
 *
 * The check covers both the lexical path and its canonical form, so a symlink
 * cannot smuggle workspaces, artifacts, databases, or client state back into
 * the checkout.
 *
 * @param candidate - Absolute state path.
 * @param primaryCheckout - Absolute primary checkout root.
 * @throws {@link Error} When the path is the checkout or one of its descendants.
 */
export const assertOutsidePrimaryCheckout = (candidate: string, primaryCheckout: string): void => {
	const checkout = canonicalPathOf(primaryCheckout);
	const resolved = path.resolve(candidate);
	const canonical = canonicalPathOf(resolved);

	if (insideOf(checkout, resolved) || insideOf(checkout, canonical)) {
		throw new Error(`evaluation state must live outside the primary checkout (${checkout}): ${resolved}`);
	}
};

/**
 * Resolves the disposable root for workspaces, staged artifacts, databases,
 * client stores, and result records.
 *
 * `EVALUATION_STATE_ROOT` selects an explicit root. The default is a stable
 * per-checkout directory under the operating system temporary directory, so a
 * campaign never writes mutable state into the checkout it evaluates.
 *
 * @param input - Evaluation root, primary checkout, environment, and temp override.
 * @returns Absolute state root outside the primary checkout.
 * @throws {@link Error} When the configured root is inside the primary checkout.
 */
export const evaluationStateRootOf = (input: StateRootInputType): string => {
	const checkout = path.resolve(input.primaryCheckout);
	const configured = input.environment?.['EVALUATION_STATE_ROOT'];
	const resolved =
		configured === undefined || configured.trim().length === 0
			? path.join(
					input.temporaryDirectory ?? tmpdir(),
					'codeindex-evaluation',
					hashOf({evaluationRoot: path.resolve(input.evaluationRoot), primaryCheckout: checkout}).slice(0, 16),
				)
			: path.resolve(configured);

	assertOutsidePrimaryCheckout(resolved, checkout);

	return resolved;
};
