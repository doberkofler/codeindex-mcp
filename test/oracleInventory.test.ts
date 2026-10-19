import {beforeEach, describe, expect, it, vi} from 'vitest';
import {readInstalledOracleSources} from '../src/core/qualification/oracle/live/oracleInventory.ts';
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

describe('Oracle installed source inventory', () => {
	beforeEach(() => {
		mocks.execute.mockReset();
		mocks.close.mockReset();
		mocks.getConnection.mockReset();
		mocks.close.mockResolvedValue(undefined);
		mocks.getConnection.mockResolvedValue({execute: mocks.execute, close: mocks.close});
	});

	it('returns complete unwrapped installed source and closes the session', async () => {
		mocks.execute.mockResolvedValue({
			rows: [
				['PACKAGE', 'HR_API', 1, 'PACKAGE HR_API IS\n'],
				['PACKAGE', 'HR_API', 2, 'PROCEDURE RUN;\n'],
				['PACKAGE', 'HR_API', 3, 'END HR_API;\n'],
				['PACKAGE BODY', 'HR_API', 1, 'PACKAGE BODY HR_API IS\n'],
				['PACKAGE BODY', 'HR_API', 2, 'END HR_API;\n'],
				['PACKAGE', 'SECRET_API', 1, 'PACKAGE SECRET_API wrapped\n'],
			],
		});

		const installed = await readInstalledOracleSources(connection);

		expect([...installed.keys()]).toStrictEqual([oracleObjectKeyOf('PACKAGE', 'HR_API'), oracleObjectKeyOf('PACKAGE BODY', 'HR_API')]);
		expect(installed.get(oracleObjectKeyOf('PACKAGE', 'HR_API'))?.source).toBe('PACKAGE HR_API IS\nPROCEDURE RUN;\nEND HR_API;');
		expect(mocks.execute.mock.calls[0]?.[0]).not.toContain('line = 1');
		expect(mocks.close).toHaveBeenCalledWith();
	});

	it('rejects an unexpected inventory row shape', async () => {
		mocks.execute.mockResolvedValue({rows: [['PACKAGE', 'HR_API', 1]]});

		await expect(readInstalledOracleSources(connection)).rejects.toThrow(/unexpected row shape/u);
		expect(mocks.close).toHaveBeenCalledWith();
	});
});
