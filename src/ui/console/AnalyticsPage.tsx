import {
	Alert,
	Box,
	Card,
	CardContent,
	Divider,
	Grid,
	IconButton,
	Skeleton,
	Stack,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	ToggleButton,
	ToggleButtonGroup,
	Tooltip,
	Typography,
} from '@mui/material';
import AnalyticsIcon from '@mui/icons-material/Analytics';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import SpeedIcon from '@mui/icons-material/Speed';
import {type AnalyticsDashboardType, type AnalyticsToolType, type AnalyticsWindowType} from '../../transports/console/contracts.ts';
import {BarList} from './components/BarList.tsx';
import {MetricCard} from './components/MetricCard.tsx';
import {TimeSeriesChart} from './components/TimeSeriesChart.tsx';
import {ToolDialog} from './components/ToolDialog.tsx';
import {formatBytes, formatDuration, formatNumber, formatPercent, formatTimestamp} from './format.ts';
import {rememberOverlayTrigger} from './overlayFocus.ts';

const WINDOWS: readonly AnalyticsWindowType[] = ['1h', '24h', '7d', '30d', 'all'];
const COLORS = {tools: '#14b8a6', errors: '#ef4444', events: '#8b5cf6', builds: '#f59e0b'};

type AnalyticsPagePropsType = Readonly<{
	dashboard: AnalyticsDashboardType | undefined;
	window: AnalyticsWindowType;
	loading: boolean;
	error: string | null;
	selectedTool: AnalyticsToolType | null;
	onWindowChange: (window: AnalyticsWindowType) => void;
	onSelectTool: (tool: AnalyticsToolType | null) => void;
}>;

const AnalyticsKpis = ({dashboard}: Readonly<{dashboard: AnalyticsDashboardType}>) => (
	<Grid container spacing={2}>
		<Grid size={{xs: 12, sm: 6, lg: 3}}>
			<MetricCard label="Tool calls" value={formatNumber(dashboard.totals.toolCalls)} icon={<AnalyticsIcon />} hint="Across retained MCP sessions" />
		</Grid>
		<Grid size={{xs: 12, sm: 6, lg: 3}}>
			<MetricCard
				label="Error rate"
				value={formatPercent(dashboard.totals.errorRate)}
				icon={<ErrorOutlinedIcon />}
				hint={`${formatNumber(dashboard.totals.errors)} failed calls`}
				accent={dashboard.totals.errorRate > 0.05 ? 'warning' : 'success'}
			/>
		</Grid>
		<Grid size={{xs: 12, sm: 6, lg: 3}}>
			<MetricCard
				label="Build p95"
				value={formatDuration(dashboard.builds.p95Ms)}
				icon={<SpeedIcon />}
				hint={`${formatNumber(dashboard.totals.builds)} builds, ${formatNumber(dashboard.totals.buildFailures)} failures`}
				accent="secondary"
			/>
		</Grid>
		<Grid size={{xs: 12, sm: 6, lg: 3}}>
			<MetricCard
				label="Response payload"
				value={formatBytes(dashboard.totals.bytes)}
				icon={<AnalyticsIcon />}
				hint={`${formatNumber(dashboard.totals.truncated)} truncated responses`}
				accent="warning"
			/>
		</Grid>
	</Grid>
);

const AnalyticsTimeline = ({dashboard}: Readonly<{dashboard: AnalyticsDashboardType}>) => (
	<Card>
		<CardContent>
			<Stack direction={{xs: 'column', sm: 'row'}} sx={{mb: 1, justifyContent: 'space-between', alignItems: {sm: 'center'}}}>
				<Box>
					<Typography variant="h6">Activity timeline</Typography>
					<Typography variant="body2" color="text.secondary">
						{formatNumber(dashboard.window.events)} events from {formatTimestamp(dashboard.window.firstTimestamp)} to{' '}
						{formatTimestamp(dashboard.window.lastTimestamp)}
					</Typography>
				</Box>
			</Stack>
			<TimeSeriesChart
				series={[
					{
						label: 'Tool calls',
						color: COLORS.tools,
						points: dashboard.timeline.map((point) => ({x: Date.parse(point.bucketStart), y: point.toolCalls})),
						fill: true,
					},
					{
						label: 'Errors',
						color: COLORS.errors,
						points: dashboard.timeline.map((point) => ({x: Date.parse(point.bucketStart), y: point.errors})),
					},
					{
						label: 'All events',
						color: COLORS.events,
						points: dashboard.timeline.map((point) => ({x: Date.parse(point.bucketStart), y: point.events})),
					},
				]}
			/>
		</CardContent>
	</Card>
);

const ToolsTable = ({tools, onSelect}: Readonly<{tools: readonly AnalyticsToolType[]; onSelect: (tool: AnalyticsToolType) => void}>) => (
	<TableContainer>
		<Table size="small">
			<TableHead>
				<TableRow>
					<TableCell>Tool</TableCell>
					<TableCell align="right">Calls</TableCell>
					<TableCell align="right">Errors</TableCell>
					<TableCell align="right">p50</TableCell>
					<TableCell align="right">p95</TableCell>
					<TableCell align="right">p99</TableCell>
					<TableCell align="right">Payload</TableCell>
					<TableCell />
				</TableRow>
			</TableHead>
			<TableBody>
				{tools.map((tool) => (
					<TableRow
						key={tool.name}
						hover
						sx={{cursor: 'pointer'}}
						onClick={(event) => {
							rememberOverlayTrigger(event.currentTarget);
							onSelect(tool);
						}}
					>
						<TableCell>
							<Typography variant="body2" sx={{fontWeight: 600}}>
								{tool.name}
							</Typography>
						</TableCell>
						<TableCell align="right">{formatNumber(tool.calls)}</TableCell>
						<TableCell align="right" sx={{color: tool.errors > 0 ? 'error.main' : 'text.primary'}}>
							{formatNumber(tool.errors)}
						</TableCell>
						<TableCell align="right">{formatDuration(tool.p50Ms)}</TableCell>
						<TableCell align="right">{formatDuration(tool.p95Ms)}</TableCell>
						<TableCell align="right">{formatDuration(tool.p99Ms)}</TableCell>
						<TableCell align="right">{formatBytes(tool.bytes)}</TableCell>
						<TableCell align="right">
							<Tooltip title="Inspect tool">
								<IconButton size="small" aria-label={`Inspect ${tool.name}`}>
									<ChevronRightIcon fontSize="small" />
								</IconButton>
							</Tooltip>
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	</TableContainer>
);

const ToolsCard = ({tools, onSelect}: Readonly<{tools: readonly AnalyticsToolType[]; onSelect: (tool: AnalyticsToolType) => void}>) => (
	<Card>
		<CardContent sx={{pb: 0}}>
			<Typography variant="h6">Tools</Typography>
			<Typography variant="body2" color="text.secondary" sx={{mb: 1}}>
				Click a row to inspect its latency distribution and timeline.
			</Typography>
		</CardContent>
		{tools.length === 0 ? (
			<Box sx={{p: 3}}>
				<Typography variant="body2" color="text.secondary">
					No MCP tool calls have been recorded in this window.
				</Typography>
			</Box>
		) : (
			<ToolsTable tools={tools} onSelect={onSelect} />
		)}
	</Card>
);

const BuildsCard = ({dashboard}: Readonly<{dashboard: AnalyticsDashboardType}>) => (
	<Card sx={{height: '100%'}}>
		<CardContent>
			<Typography variant="h6" gutterBottom>
				Build health
			</Typography>
			<TimeSeriesChart
				height={210}
				emptyLabel="No build events in this window"
				series={[
					{
						label: 'Duration (ms)',
						color: COLORS.builds,
						points: dashboard.builds.timeline.map((point) => ({x: Date.parse(point.timestamp), y: point.durationMs})),
						fill: true,
					},
				]}
			/>
			<Divider sx={{my: 2}} />
			<BarList
				items={dashboard.builds.stages.map((stage) => ({
					label: stage.stage,
					value: stage.p50Ms ?? 0,
					display: `${formatDuration(stage.p50Ms)} p50 · ${formatDuration(stage.p95Ms)} p95`,
					color: 'secondary',
				}))}
				emptyLabel="No stage timings"
			/>
		</CardContent>
	</Card>
);

const SignalsCard = ({dashboard}: Readonly<{dashboard: AnalyticsDashboardType}>) => (
	<Card sx={{height: '100%'}}>
		<CardContent>
			<Typography variant="h6" gutterBottom>
				Freshness & watcher
			</Typography>
			<BarList
				items={dashboard.freshness.map((entry) => ({
					label: entry.state,
					value: entry.count,
					display: formatNumber(entry.count),
					color: entry.state === 'current' ? 'success' : entry.state === 'stale' ? 'error' : 'warning',
				}))}
				emptyLabel="No freshness samples"
			/>
			<Divider sx={{my: 2}} />
			<Stack spacing={1}>
				<Stack direction="row" sx={{justifyContent: 'space-between'}}>
					<Typography variant="body2" color="text.secondary">
						Watcher events
					</Typography>
					<Typography variant="body2">{formatNumber(dashboard.watcher.events)}</Typography>
				</Stack>
				<Stack direction="row" sx={{justifyContent: 'space-between'}}>
					<Typography variant="body2" color="text.secondary">
						Published refreshes
					</Typography>
					<Typography variant="body2">{formatNumber(dashboard.watcher.refreshes)}</Typography>
				</Stack>
				<Stack direction="row" sx={{justifyContent: 'space-between'}}>
					<Typography variant="body2" color="text.secondary">
						Coalesced events
					</Typography>
					<Typography variant="body2">{formatNumber(dashboard.watcher.coalesced)}</Typography>
				</Stack>
				<Stack direction="row" sx={{justifyContent: 'space-between'}}>
					<Typography variant="body2" color="text.secondary">
						Event → publication p95
					</Typography>
					<Typography variant="body2">{formatDuration(dashboard.watcher.eventToPublicationP95Ms)}</Typography>
				</Stack>
			</Stack>
		</CardContent>
	</Card>
);

const AnalyticsContent = ({dashboard, onSelectTool}: Readonly<{dashboard: AnalyticsDashboardType; onSelectTool: (tool: AnalyticsToolType) => void}>) => (
	<Stack spacing={3}>
		<AnalyticsKpis dashboard={dashboard} />
		<AnalyticsTimeline dashboard={dashboard} />
		<ToolsCard tools={dashboard.tools} onSelect={onSelectTool} />
		<Grid container spacing={2}>
			<Grid size={{xs: 12, lg: 7}}>
				<BuildsCard dashboard={dashboard} />
			</Grid>
			<Grid size={{xs: 12, lg: 5}}>
				<SignalsCard dashboard={dashboard} />
			</Grid>
		</Grid>
	</Stack>
);

export const AnalyticsPage = ({dashboard, window, loading, error, selectedTool, onWindowChange, onSelectTool}: AnalyticsPagePropsType) => (
	<Stack spacing={3}>
		<Stack direction={{xs: 'column', md: 'row'}} spacing={2} sx={{justifyContent: 'space-between'}}>
			<Box>
				<Typography variant="h4">Analytics</Typography>
				<Typography color="text.secondary">Privacy-safe aggregates from local MCP and build telemetry. No source, prompts, or queries.</Typography>
			</Box>
			<ToggleButtonGroup
				size="small"
				exclusive
				value={window}
				onChange={(_event, value: AnalyticsWindowType | null) => {
					if (value !== null) {
						onWindowChange(value);
					}
				}}
			>
				{WINDOWS.map((candidate) => (
					<ToggleButton key={candidate} value={candidate} sx={{px: 2}}>
						{candidate}
					</ToggleButton>
				))}
			</ToggleButtonGroup>
		</Stack>
		{error === null ? null : <Alert severity="error">{error}</Alert>}
		{loading && dashboard === undefined ? (
			<Stack spacing={2}>
				<Skeleton variant="rounded" height={120} />
				<Skeleton variant="rounded" height={320} />
				<Skeleton variant="rounded" height={260} />
			</Stack>
		) : dashboard === undefined ? (
			<Alert severity="info">Analytics are not available yet.</Alert>
		) : dashboard.window.events === 0 ? (
			<Card>
				<CardContent sx={{py: 8, textAlign: 'center'}}>
					<Typography variant="h6" gutterBottom>
						No analytics in this window
					</Typography>
					<Typography color="text.secondary">Run MCP queries or change the window to see aggregates.</Typography>
				</CardContent>
			</Card>
		) : (
			<AnalyticsContent dashboard={dashboard} onSelectTool={onSelectTool} />
		)}
		<ToolDialog
			tool={selectedTool}
			onClose={() => {
				onSelectTool(null);
			}}
		/>
	</Stack>
);
