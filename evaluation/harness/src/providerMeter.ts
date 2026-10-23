import {createServer, type Server} from 'node:http';
import {once} from 'node:events';
import {handleMeteredRequestOf, ledgerOf, type ProviderMeterStateType} from './providerMeterProxy.ts';
import {type ProviderMeterInputType, type ProviderMeterType, reconcileProviderMeterLedger} from './providerMeterLedger.ts';

export {type ProviderMeterLedgerType, type ProviderMeterType, providerMeterConfigOf, reconcileProviderMeterLedger} from './providerMeterLedger.ts';

const listenOf = async (server: Server): Promise<number> => {
	const listening = Promise.withResolvers<number>();

	server.once('error', (error: Error) => {
		listening.reject(error);
	});
	server.listen(0, '127.0.0.1', () => {
		const address = server.address();

		if (address === null || typeof address === 'string') {
			listening.reject(new Error('provider meter did not bind a TCP port'));

			return;
		}

		listening.resolve(address.port);
	});

	const port = await listening.promise;

	return port;
};

/**
 * Starts a loopback provider proxy that meters every request and terminal response.
 *
 * OpenCode is pointed at `baseUrl` through a private provider. The proxy forwards
 * each request to `upstreamBaseUrl`, records only sanitized metadata, and reads
 * provider-reported usage from the terminal response body. The ledger depends
 * on neither OpenCode event-stream ordering nor OpenCode's session database.
 *
 * @param input - Upstream target, provider identity, optional headers, and bounds.
 * @returns The running meter, its ledger, reconciliation, and a close function.
 */
export const startProviderMeter = async (input: ProviderMeterInputType): Promise<ProviderMeterType> => {
	const state: ProviderMeterStateType = {requests: [], inFlight: new Set(), closed: false};
	const server = createServer((request, response) => {
		state.inFlight.add(handleMeteredRequestOf(state, input, request, response));
	});
	const port = await listenOf(server);
	const closed = once(server, 'close');

	const close = async (): Promise<void> => {
		state.closed = true;
		server.close();
		await Promise.allSettled(state.inFlight);
		server.closeAllConnections();
		await closed;
	};

	return {
		provider: input.provider,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		port,
		ledger: () => ledgerOf(state, input.provider),
		reconciliation: () => reconcileProviderMeterLedger(ledgerOf(state, input.provider)),
		close,
	};
};
