import {beforeEach, describe, expect, it, vi} from 'vitest';
import {readInstalledOracleObjects} from '../src/core/qualification/oracle/live/oracleInventory.ts';
import {oracleObjectKeyOf} from '../src/core/qualification/oracle/live/oracleLiveSource.ts';

const mocks = vi.hoisted(() => ({
	execute: vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(),
	close: vi.fn<() => Promise<void>>(),
	getConnection: vi.fn<() => Promise<unknown>>(),
}));

vi.mock(
	import('oracledb'),
	() =>
		({
			default: {
				OUT_FORMAT_ARRAY: 1,
				getConnection: mocks.getConnection,
			},
		}) as unknown as never,
);

const connection = {server: 'server', user: 'user', password: 'secret'};

describe('Oracle installed object inventory', () => {
	beforeEach(() => {
		mocks.execute.mockReset();
		mocks.close.mockReset();
		mocks.getConnection.mockReset();
		mocks.close.mockResolvedValue(undefined);
		mocks.getConnection.mockResolvedValue({execute: mocks.execute, close: mocks.close});
	});

	it('returns unwrapped installed objects and closes the session', async () => {
		mocks.execute.mockResolvedValue({
			rows: [
				['PACKAGE', 'HR_API', 1, 'PACKAGE HR_API IS\n'],
				['PACKAGE BODY', 'HR_API', 1, 'PACKAGE BODY HR_API IS\n'],
				['PACKAGE', 'SECRET_API', 1, 'PACKAGE SECRET_API wrapped\n'],
			],
		});

		const installed = await readInstalledOracleObjects(connection);

		expect([...installed]).toStrictEqual([oracleObjectKeyOf('PACKAGE', 'HR_API'), oracleObjectKeyOf('PACKAGE BODY', 'HR_API')]);
		expect(mocks.close).toHaveBeenCalledWith();
	});

	it('rejects an unexpected inventory row shape', async () => {
		mocks.execute.mockResolvedValue({rows: [['PACKAGE', 'HR_API', 1]]});

		await expect(readInstalledOracleObjects(connection)).rejects.toThrow(/unexpected row shape/u);
		expect(mocks.close).toHaveBeenCalledWith();
	});
});
