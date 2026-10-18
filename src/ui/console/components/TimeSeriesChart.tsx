import {Box, Typography, useTheme} from '@mui/material';
import {useId} from 'react';
import {formatClock} from '../format.ts';

type TimeSeriesPointType = Readonly<{x: number; y: number}>;

type TimeSeriesSeriesType = Readonly<{
	label: string;
	color: string;
	points: readonly TimeSeriesPointType[];
	fill?: boolean;
}>;

type TimeSeriesChartPropsType = Readonly<{
	series: readonly TimeSeriesSeriesType[];
	height?: number;
	emptyLabel?: string;
}>;

const WIDTH = 1_000;
const PADDING = 44;

const pathOf = (points: readonly TimeSeriesPointType[], xOf: (value: number) => number, yOf: (value: number) => number): string =>
	points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xOf(point.x).toFixed(1)} ${yOf(point.y).toFixed(1)}`).join(' ');

export const TimeSeriesChart = ({series, height = 280, emptyLabel = 'No data in this window'}: TimeSeriesChartPropsType) => {
	const theme = useTheme();
	const gradientId = useId().replaceAll(':', '');
	const allPoints = series.flatMap((entry) => entry.points);
	const empty = allPoints.length === 0;

	if (empty) {
		return (
			<Box sx={{height, display: 'grid', placeItems: 'center', color: 'text.secondary'}}>
				<Typography variant="body2">{emptyLabel}</Typography>
			</Box>
		);
	}

	const minX = Math.min(...allPoints.map((point) => point.x));
	const maxX = Math.max(...allPoints.map((point) => point.x));
	const maxY = Math.max(1, ...allPoints.map((point) => point.y));
	const xOf = (value: number): number => PADDING + ((value - minX) / Math.max(1, maxX - minX)) * (WIDTH - PADDING * 2);
	const yOf = (value: number): number => height - PADDING - (value / maxY) * (height - PADDING * 2);
	const gridValues = [0, 0.25, 0.5, 0.75, 1];
	const axis = theme.palette.divider;
	const labelColor = theme.palette.text.secondary;
	const first = series.at(0);
	const area =
		first === undefined || first.points.length === 0 ? null : `${pathOf(first.points, xOf, yOf)} L ${xOf(maxX)} ${yOf(0)} L ${xOf(minX)} ${yOf(0)} Z`;

	return (
		<Box sx={{width: '100%', overflow: 'hidden'}}>
			<Box component="svg" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="Time series chart" sx={{width: '100%', height: 'auto', display: 'block'}}>
				<defs>
					<linearGradient id={`fill-${gradientId}`} x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stopColor={first?.color ?? theme.palette.primary.main} stopOpacity="0.28" />
						<stop offset="100%" stopColor={first?.color ?? theme.palette.primary.main} stopOpacity="0" />
					</linearGradient>
				</defs>
				{gridValues.map((fraction) => {
					const y = yOf(maxY * fraction);
					return (
						<g key={fraction}>
							<line x1={PADDING} x2={WIDTH - PADDING} y1={y} y2={y} stroke={axis} strokeDasharray={fraction === 0 ? undefined : '4 8'} strokeWidth="1" />
							<text x={PADDING - 10} y={y + 4} textAnchor="end" fill={labelColor} fontSize="12">
								{Math.round(maxY * fraction)}
							</text>
						</g>
					);
				})}
				{area === null ? null : <path d={area} fill={`url(#fill-${gradientId})`} />}
				{series.map((entry) => (
					<g key={entry.label}>
						<path d={pathOf(entry.points, xOf, yOf)} fill="none" stroke={entry.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
						{entry.points.map((point) => (
							<circle key={`${entry.label}-${point.x}`} cx={xOf(point.x)} cy={yOf(point.y)} r="3" fill={entry.color}>
								<title>{`${entry.label}: ${point.y} at ${formatClock(new Date(point.x).toISOString())}`}</title>
							</circle>
						))}
					</g>
				))}
				<text x={PADDING} y={height - 12} fill={labelColor} fontSize="12">
					{formatClock(new Date(minX).toISOString())}
				</text>
				<text x={WIDTH - PADDING} y={height - 12} textAnchor="end" fill={labelColor} fontSize="12">
					{formatClock(new Date(maxX).toISOString())}
				</text>
			</Box>
			<Box sx={{display: 'flex', flexWrap: 'wrap', gap: 2, mt: 1}}>
				{series.map((entry) => (
					<Box key={entry.label} sx={{display: 'flex', alignItems: 'center', gap: 0.75}}>
						<Box sx={{width: 10, height: 10, borderRadius: '50%', bgcolor: entry.color}} />
						<Typography variant="caption" color="text.secondary">
							{entry.label}
						</Typography>
					</Box>
				))}
			</Box>
		</Box>
	);
};
