import {Box, Dialog, DialogContent, DialogTitle, Divider, Grid, IconButton, Stack, Typography} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {type AnalyticsToolType} from '../../../transports/console/contracts.ts';
import {formatBytes, formatDuration, formatNumber, formatPercent} from '../format.ts';
import {BarList} from './BarList.tsx';
import {TimeSeriesChart} from './TimeSeriesChart.tsx';

type ToolDialogPropsType = Readonly<{
	tool: AnalyticsToolType | null;
	onClose: () => void;
}>;

export const ToolDialog = ({tool, onClose}: ToolDialogPropsType) => (
	<Dialog open={tool !== null} onClose={onClose} maxWidth="md" fullWidth>
		<DialogTitle sx={{display: 'flex', alignItems: 'center', gap: 1, pr: 6}}>
			{tool?.name ?? 'Tool'}
			<IconButton aria-label="Close" onClick={onClose} sx={{position: 'absolute', right: 12, top: 12}}>
				<CloseIcon />
			</IconButton>
		</DialogTitle>
		<DialogContent dividers>
			{tool === null ? null : (
				<Stack spacing={3}>
					<Grid container spacing={2}>
						{[
							['Calls', formatNumber(tool.calls)],
							['Errors', `${formatNumber(tool.errors)} · ${formatPercent(tool.errorRate)}`],
							['p50', formatDuration(tool.p50Ms)],
							['p95', formatDuration(tool.p95Ms)],
							['p99', formatDuration(tool.p99Ms)],
							['Payload', formatBytes(tool.bytes)],
						].map(([label, value]) => (
							<Grid key={label} size={{xs: 6, sm: 4}}>
								<Typography variant="overline" color="text.secondary">
									{label}
								</Typography>
								<Typography variant="h6">{value}</Typography>
							</Grid>
						))}
					</Grid>
					<Divider />
					<Box>
						<Typography variant="h6" gutterBottom>
							Call timeline
						</Typography>
						<TimeSeriesChart
							height={230}
							series={[
								{
									label: 'Calls',
									color: '#14b8a6',
									points: tool.timeline.map((point) => ({x: Date.parse(point.bucketStart), y: point.calls})),
									fill: true,
								},
								{
									label: 'Errors',
									color: '#ef4444',
									points: tool.timeline.map((point) => ({x: Date.parse(point.bucketStart), y: point.errors})),
								},
							]}
						/>
					</Box>
					<Box>
						<Typography variant="h6" gutterBottom>
							Latency distribution
						</Typography>
						<BarList
							items={tool.latencyBuckets.map((bucket) => ({
								label: bucket.label,
								value: bucket.count,
								display: formatNumber(bucket.count),
								color: bucket.count === 0 ? 'primary' : 'secondary',
							}))}
						/>
					</Box>
				</Stack>
			)}
		</DialogContent>
	</Dialog>
);
