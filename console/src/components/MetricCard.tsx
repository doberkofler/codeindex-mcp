import {Box, Card, CardContent, Typography, alpha} from '@mui/material';
import {type ReactNode} from 'react';

type MetricCardPropsType = Readonly<{
	label: string;
	value: string;
	hint?: string;
	icon: ReactNode;
	accent?: 'primary' | 'secondary' | 'success' | 'warning';
}>;

export const MetricCard = ({label, value, hint, icon, accent = 'primary'}: MetricCardPropsType) => (
	<Card
		sx={{
			height: '100%',
			position: 'relative',
			overflow: 'hidden',
			'&::after': {
				content: '""',
				position: 'absolute',
				inset: 'auto -30px -45px auto',
				width: '130px',
				height: '130px',
				borderRadius: '50%',
				background: (theme) => alpha(theme.palette[accent].main, 0.12),
			},
		}}
	>
		<CardContent sx={{position: 'relative', zIndex: 1}}>
			<Box sx={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2}}>
				<Typography variant="overline" color="text.secondary" sx={{letterSpacing: '0.12em'}}>
					{label}
				</Typography>
				<Box sx={{color: `${accent}.main`, display: 'flex'}}>{icon}</Box>
			</Box>
			<Typography variant="h4" sx={{mt: 1.2, fontVariantNumeric: 'tabular-nums'}}>
				{value}
			</Typography>
			{hint === undefined ? null : (
				<Typography variant="caption" color="text.secondary">
					{hint}
				</Typography>
			)}
		</CardContent>
	</Card>
);
