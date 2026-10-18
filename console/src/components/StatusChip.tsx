import {Chip} from '@mui/material';
import {type IndexStatusType} from '../../../src/index/model.ts';

type StatusChipPropsType = Readonly<{
	status: IndexStatusType;
}>;

export const StatusChip = ({status}: StatusChipPropsType) => {
	const healthy = status.state === 'published' && status.freshness.state === 'current';
	const updating = status.building || status.freshness.state === 'updating';

	return (
		<Chip
			size="small"
			label={healthy ? 'Live and current' : updating ? 'Updating' : status.freshness.state === 'stale' ? 'Stale' : 'Index unavailable'}
			color={healthy ? 'success' : updating ? 'warning' : 'error'}
			variant={healthy ? 'filled' : 'outlined'}
			sx={{fontWeight: 600}}
		/>
	);
};
