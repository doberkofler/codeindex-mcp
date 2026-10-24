// @vitest-environment jsdom
import {cleanup, screen} from '@testing-library/react';
import {userEvent} from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BarList} from '../src/ui/console/components/BarList.tsx';
import {MetricCard} from '../src/ui/console/components/MetricCard.tsx';
import {StatusChip} from '../src/ui/console/components/StatusChip.tsx';
import {TimeSeriesChart} from '../src/ui/console/components/TimeSeriesChart.tsx';
import {ToolDialog} from '../src/ui/console/components/ToolDialog.tsx';
import {createConsoleTheme} from '../src/ui/console/theme.ts';
import {installBrowserStubs, renderWithProviders, statusOf, toolOf} from './helpers/consoleUi.tsx';

const chartSeries = [
	{
		label: 'Tool calls',
		color: '#14b8a6',
		points: [
			{x: Date.parse('2026-10-24T10:00:00.000Z'), y: 2},
			{x: Date.parse('2026-10-24T10:15:00.000Z'), y: 5},
		],
		fill: true,
	},
	{
		label: 'Errors',
		color: '#ef4444',
		points: [{x: Date.parse('2026-10-24T10:15:00.000Z'), y: 1}],
	},
];

describe('console presentational components', () => {
	afterEach(cleanup);

	it('renders bar rows and both empty labels', () => {
		const {rerender} = renderWithProviders(<BarList items={[]} />);
		expect(screen.getByText('No data')).not.toBeNull();

		rerender(<BarList items={[]} emptyLabel="Nothing measured" />);
		expect(screen.getByText('Nothing measured')).not.toBeNull();

		rerender(
			<BarList
				items={[
					{label: 'scan', value: 10, display: '10 ms', color: 'secondary'},
					{label: 'extract', value: 5, display: '5 ms'},
				]}
			/>,
		);
		expect(screen.getByText('scan')).not.toBeNull();
		expect(screen.getByText('extract')).not.toBeNull();
		expect(screen.getAllByRole('progressbar')).toHaveLength(2);
	});

	it('renders metric cards with and without hints', () => {
		const {rerender} = renderWithProviders(<MetricCard label="Files" value="12" icon={<span>icon</span>} />);
		expect(screen.getByText('Files')).not.toBeNull();
		expect(screen.getByText('12')).not.toBeNull();
		expect(screen.queryByText('hint')).toBeNull();

		rerender(<MetricCard label="Symbols" value="34" hint="hint" icon={<span>icon</span>} accent="secondary" />);
		expect(screen.getByText('hint')).not.toBeNull();
	});

	it.each([
		[statusOf(), 'Live and current'],
		[statusOf({state: 'building', building: true}), 'Updating'],
		[statusOf({freshness: {...statusOf().freshness, state: 'updating'}}), 'Updating'],
		[statusOf({freshness: {...statusOf().freshness, state: 'stale'}}), 'Stale'],
		[statusOf({state: 'absent', freshness: {...statusOf().freshness, state: 'unknown'}}), 'Index unavailable'],
	] as const)('maps index status to the status chip', (status, label) => {
		renderWithProviders(<StatusChip status={status} />);

		expect(screen.getByText(label)).not.toBeNull();
	});

	it('renders empty and populated time series charts', () => {
		const {rerender} = renderWithProviders(<TimeSeriesChart series={[]} />);
		expect(screen.getByText('No data in this window')).not.toBeNull();

		rerender(<TimeSeriesChart series={[]} emptyLabel="No build events" />);
		expect(screen.getByText('No build events')).not.toBeNull();

		rerender(<TimeSeriesChart series={chartSeries} />);
		expect(screen.getByRole('img', {name: 'Time series chart'})).not.toBeNull();
		expect(screen.getByText('Tool calls')).not.toBeNull();
		expect(screen.getByText('Errors')).not.toBeNull();
		expect([...globalThis.document.querySelectorAll('title')].some((title) => title.textContent.startsWith('Tool calls: 5 at'))).toBe(true);
	});

	it('renders the tool dialog closed and its metrics when open', async () => {
		installBrowserStubs();
		const onClose = vi.fn<() => void>();
		const tool = toolOf();

		const {rerender} = renderWithProviders(<ToolDialog tool={null} onClose={onClose} />);
		expect(screen.queryByText(tool.name)).toBeNull();

		rerender(<ToolDialog tool={tool} onClose={onClose} />);
		expect(screen.getByText(tool.name)).not.toBeNull();
		expect(screen.getAllByText('Calls').length).toBeGreaterThan(0);
		expect(screen.getByText('Latency distribution')).not.toBeNull();

		await userEvent.click(screen.getByRole('button', {name: 'Close'}));
		// oxlint-disable-next-line vitest/prefer-to-have-length -- Assert the exact call count without the conflicting mock-call rules.
		expect(onClose.mock.calls.length).toBe(1);
	});

	it('builds light and dark themes with semantic palette tokens', () => {
		const light = createConsoleTheme('light');
		const dark = createConsoleTheme('dark');

		expect(light.palette.mode).toBe('light');
		expect(dark.palette.mode).toBe('dark');
		expect(light.palette.background.default).not.toBe(dark.palette.background.default);
		expect(light.palette.text.primary).not.toBe(dark.palette.text.primary);
		expect(light.palette.divider).not.toBe(dark.palette.divider);
		expect(light.components?.MuiCard?.styleOverrides?.root).toMatchObject({borderColor: 'divider'});
		expect(dark.components?.MuiCard?.styleOverrides?.root).toMatchObject({borderColor: 'divider'});
	});
});
