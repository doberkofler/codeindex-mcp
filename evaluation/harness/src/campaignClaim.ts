import {type EnvironmentManifestType} from './environment.ts';
import {type HostedReferenceType} from './hostedReference.ts';

export type CampaignClaimClassType = 'none' | 'local-model-scoped' | 'hosted-model-scoped';

export const assertClaimEnvironmentOf = (
	claimClass: CampaignClaimClassType | undefined,
	environment: EnvironmentManifestType | null,
	hostedReference: HostedReferenceType | null,
): void => {
	if (claimClass === 'local-model-scoped' && environment === null) {
		throw new Error('local-model-scoped evidence requires a pinned local environment');
	}

	if (claimClass === 'local-model-scoped' && hostedReference !== null) {
		throw new Error('local-model-scoped evidence must not use a hosted reference');
	}

	if (claimClass === 'hosted-model-scoped' && environment !== null) {
		throw new Error('hosted-model-scoped evidence must not use a pinned local environment');
	}

	if (claimClass === 'hosted-model-scoped' && hostedReference === null) {
		throw new Error('hosted-model-scoped evidence requires a pinned hosted reference');
	}

	if (claimClass === 'none' && (environment !== null || hostedReference !== null)) {
		throw new Error('unscoped evidence must not declare a pinned local or hosted reference');
	}
};
