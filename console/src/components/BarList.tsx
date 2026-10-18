import {Box, LinearProgress, Typography} from '@mui/material';

type BarListItemType = Readonly<{
	label: string;
	value: number;
	display: string;
	color?: 'primary' | 'secondary' | 'success' | 'warning' | 'error';
}>;

type BarListPropsType = Readonly<{
	items: readonly BarListItemType[];
	emptyLabel?: string;
}>;

export const BarList = ({items, emptyLabel = 'No data'}: BarListPropsType) => {
	if (items.length === 0) {
		return (
			<Typography variant="body2" color="text.secondary">
				{emptyLabel}
			</Typography>
		);
	}

	const maximum = Math.max(1, ...items.map((item) => item.value));

	return (
		<Box sx={{display: 'flex', flexDirection: 'column', gap: 1.5}}>
			{items.map((item) => (
				<Box key={item.label}>
					<Box sx={{display: 'flex', justifyContent: 'space-between', gap: 2, mb: 0.5}}>
						<Typography variant="body2" sx={{fontWeight: 550}}>
							{item.label}
						</Typography>
						<Typography variant="body2" color="text.secondary" sx={{fontVariantNumeric: 'tabular-nums'}}>
							{item.display}
						</Typography>
					</Box>
					<LinearProgress
						variant="determinate"
						value={(item.value / maximum) * 100}
						color={item.color ?? 'primary'}
						sx={{height: 7, borderRadius: 99, bgcolor: 'action.hover'}}
					/>
				</Box>
			))}
		</Box>
	);
};
