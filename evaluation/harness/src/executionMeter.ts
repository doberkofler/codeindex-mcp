import {EVALUATION_CONTRACT} from './economicContract.ts';
import {providerMeterConfigOf, startProviderMeter} from './providerMeter.ts';
import {type ProviderMeterInputType, type ProviderMeterReconciliationType} from './providerMeterLedger.ts';
import {taskCostVectorOf, type TaskCostVectorType} from './taskCost.ts';

/**
 * Provider-meter configuration for one execution.
 *
 * The provider and model ID build the private OpenAI-compatible provider that
 * points at the loopback meter. Credentials are supplied as forwarded upstream
 * headers and are never written to a result or ledger.
 */
export type ExecutionProviderMeterType = ProviderMeterInputType & Readonly<{modelId: string}>;

/** Live execution meter with its process environment and terminal product. */
export type ExecutionMeterType = Readonly<{
	environment: Readonly<Record<string, string>>;
	finish: () => Promise<Readonly<{cost: TaskCostVectorType | null; reconciliation: ProviderMeterReconciliationType | null}>>;
}>;

const idleMeterOf = (): ExecutionMeterType => ({
	environment: {},
	finish: async () => {
		await Promise.resolve();

		return {cost: null, reconciliation: null};
	},
});

/**
 * Starts a loopback provider meter for one execution attempt.
 *
 * @param config - Execution provider-meter configuration, or null to skip metering.
 * @returns The provider environment injection and the terminal reconciliation.
 */
export const startExecutionMeterOf = async (config: ExecutionProviderMeterType | null): Promise<ExecutionMeterType> => {
	if (config === null) {
		return idleMeterOf();
	}

	const meter = await startProviderMeter(config);
	const environment = {
		OPENCODE_CONFIG_CONTENT: JSON.stringify(providerMeterConfigOf({baseUrl: meter.baseUrl, provider: config.provider, modelId: config.modelId})),
	};

	return {
		environment,
		finish: async () => {
			const ledger = meter.ledger();
			const reconciliation = meter.reconciliation();
			const cost = taskCostVectorOf(ledger, EVALUATION_CONTRACT.tariff);

			await meter.close();

			return {cost, reconciliation};
		},
	};
};
