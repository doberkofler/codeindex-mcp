import {describe, expect, it} from 'vitest';
import {oracleExtractor} from '@codeindex/adapter-oracle/index';
import {typeScriptExtractor} from '@codeindex/adapter-typescript/index';
import {createFixtureConfig} from './helpers/fixture.ts';

const cancelledContext = (): Readonly<{isCancellationRequested: () => boolean; throwIfCancellationRequested: () => never}> => ({
	isCancellationRequested: () => true,
	throwIfCancellationRequested: () => {
		throw new Error('Adapter execution cancelled');
	},
});

describe('official adapter cancellation', () => {
	it('interrupts TypeScript scan and extraction at cooperative checkpoints', async () => {
		const {config, cleanup} = createFixtureConfig('simple-project');

		try {
			await expect(
				(async (): Promise<void> => {
					await typeScriptExtractor.scan(config, [], cancelledContext());
				})(),
			).rejects.toThrow('Adapter execution cancelled');
			const scan = await typeScriptExtractor.scan(config, []);

			await expect(
				(async (): Promise<void> => {
					await typeScriptExtractor.build(config, scan, undefined, cancelledContext());
				})(),
			).rejects.toThrow('Adapter execution cancelled');
		} finally {
			typeScriptExtractor.dispose?.();
			cleanup();
		}
	});

	it('interrupts Oracle scan and extraction at cooperative checkpoints', async () => {
		const {config, cleanup} = createFixtureConfig('oracle-project', [{name: 'app', project: 'oracle-index.json'}], 'oracle');

		try {
			await expect(
				(async (): Promise<void> => {
					await oracleExtractor.scan(config, [], cancelledContext());
				})(),
			).rejects.toThrow('Adapter execution cancelled');
			const scan = await oracleExtractor.scan(config, []);

			await expect(
				(async (): Promise<void> => {
					await oracleExtractor.build(config, scan, undefined, cancelledContext());
				})(),
			).rejects.toThrow('Adapter execution cancelled');
		} finally {
			cleanup();
		}
	});
});
