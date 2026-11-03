import {type FactIssueCodeType, type FactIssueType, type FinalizationPolicyType} from './types.ts';

type IssueAttributionType = Readonly<{
	readonly symbolId?: string | null | undefined;
	readonly bindingId?: string | null | undefined;
}>;

/**
 * Appends one bounded finalization violation.
 *
 * @param issues - Accumulated issues.
 * @param code - Stable violation category.
 * @param message - Description without source text or absolute paths.
 * @param attribution - Optional symbol and binding identifiers.
 */
export const addIssue = (issues: FactIssueType[], code: FactIssueCodeType, message: string, attribution: IssueAttributionType = {}): void => {
	issues.push({
		code,
		message,
		symbolId: attribution.symbolId ?? null,
		bindingId: attribution.bindingId ?? null,
	});
};

/**
 * Validates the mandatory finite ceilings.
 *
 * @param policy - Finalization controls.
 * @throws {@link Error} When the safety ceiling is not a positive safe integer.
 */
export const assertPolicy = (policy: FinalizationPolicyType): void => {
	if (!Number.isSafeInteger(policy.maxBindingsPerRoot) || policy.maxBindingsPerRoot <= 0) {
		throw new Error('Publication finalization requires a finite positive maxBindingsPerRoot ceiling');
	}
};
