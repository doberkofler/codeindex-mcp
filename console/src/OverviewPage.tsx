import {Box, Button, Card, CardContent, Chip, Divider, Grid, Stack, Typography, alpha} from '@mui/material';
import BoltIcon from '@mui/icons-material/Bolt';
import DataObjectIcon from '@mui/icons-material/DataObject';
import FolderIcon from '@mui/icons-material/Folder';
import HubIcon from '@mui/icons-material/Hub';
import MemoryIcon from '@mui/icons-material/Memory';
import RefreshIcon from '@mui/icons-material/Refresh';
import {type IndexStatusType} from '../../src/index/model.ts';
import {type ConsoleSnapshotType} from '../../src/console/contracts.ts';
import {BarList} from './components/BarList.tsx';
import {MetricCard} from './components/MetricCard.tsx';
import {StatusChip} from './components/StatusChip.tsx';
import {formatDuration, formatNumber, formatTimestamp, shortId} from './format.ts';

type OverviewPagePropsType = Readonly<{
	snapshot: ConsoleSnapshotType;
	busy: boolean;
	onOpenOperations: () => void;
	onRunUpdate: () => void;
}>;

const OverviewHero = ({
	status,
	busy,
	onOpenOperations,
	onRunUpdate,
}: Readonly<{status: IndexStatusType; busy: boolean; onOpenOperations: () => void; onRunUpdate: () => void}>) => (
	<Card
		sx={{
			position: 'relative',
			overflow: 'hidden',
			background: (theme) =>
				`linear-gradient(135deg, ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.24 : 0.12)} 0%, ${alpha(
					theme.palette.secondary.main,
					theme.palette.mode === 'dark' ? 0.14 : 0.06,
				)} 55%, transparent 100%)`,
		}}
	>
		<CardContent sx={{p: {xs: 3, md: 4}}}>
			<Stack direction={{xs: 'column', md: 'row'}} spacing={3} sx={{justifyContent: 'space-between', alignItems: {md: 'center'}}}>
				<Box>
					<Stack direction="row" spacing={1.5} sx={{mb: 1.5, alignItems: 'center'}}>
						<StatusChip status={status} />
						<Chip size="small" variant="outlined" label={`generation ${shortId(status.generationId)}`} />
					</Stack>
					<Typography variant="h3" sx={{maxWidth: 720}}>
						Your code index, at a glance.
					</Typography>
					<Typography color="text.secondary" sx={{mt: 1, maxWidth: 720}}>
						Live freshness, build health, analytics, and operational checks for the configured workspace and extractor.
					</Typography>
				</Box>
				<Stack direction="row" spacing={1.5}>
					<Button variant="outlined" startIcon={<BoltIcon />} onClick={onOpenOperations}>
						Operations
					</Button>
					<Button variant="contained" startIcon={<RefreshIcon />} disabled={busy} onClick={onRunUpdate}>
						Update index
					</Button>
				</Stack>
			</Stack>
		</CardContent>
	</Card>
);

const OverviewMetrics = ({status}: Readonly<{status: IndexStatusType}>) => (
	<Grid container spacing={2}>
		<Grid size={{xs: 12, sm: 6, lg: 3}}>
			<MetricCard label="Files" value={formatNumber(status.counts.files)} icon={<FolderIcon />} hint="Authored TypeScript files" />
		</Grid>
		<Grid size={{xs: 12, sm: 6, lg: 3}}>
			<MetricCard
				label="Symbols"
				value={formatNumber(status.counts.symbols)}
				icon={<DataObjectIcon />}
				hint="Declarations available to navigation"
				accent="secondary"
			/>
		</Grid>
		<Grid size={{xs: 12, sm: 6, lg: 3}}>
			<MetricCard label="Occurrences" value={formatNumber(status.counts.occurrences)} icon={<HubIcon />} hint="Definitions and references" accent="success" />
		</Grid>
		<Grid size={{xs: 12, sm: 6, lg: 3}}>
			<MetricCard
				label="Build duration"
				value={formatDuration(status.build.durationMs)}
				icon={<MemoryIcon />}
				hint={status.build.completedAt === null ? 'No completed build' : formatTimestamp(status.build.completedAt)}
				accent="warning"
			/>
		</Grid>
	</Grid>
);

const OverviewBuild = ({status}: Readonly<{status: IndexStatusType}>) => {
	const stages = Object.entries(status.build.stages ?? {}).map(([stage, value]) => ({
		label: stage,
		value,
		display: formatDuration(value),
		color: 'primary' as const,
	}));

	return (
		<Card sx={{height: '100%'}}>
			<CardContent>
				<Typography variant="h6" gutterBottom>
					Build stages
				</Typography>
				<Typography variant="body2" color="text.secondary" sx={{mb: 2}}>
					Where the last published generation spent its time.
				</Typography>
				<BarList items={stages} emptyLabel="No build stage timings recorded yet" />
			</CardContent>
		</Card>
	);
};

const OverviewScope = ({status}: Readonly<{status: IndexStatusType}>) => (
	<Card sx={{height: '100%'}}>
		<CardContent>
			<Typography variant="h6" gutterBottom>
				Freshness & scope
			</Typography>
			<Stack spacing={1.5} divider={<Divider flexItem />}>
				<Box>
					<Typography variant="overline" color="text.secondary">
						Freshness
					</Typography>
					<Typography>{status.freshness.state}</Typography>
					<Typography variant="caption" color="text.secondary">
						{status.freshness.dirtyFileCount ?? 'project-wide'} dirty file(s), checked {formatTimestamp(status.freshness.checkedAt)}
					</Typography>
				</Box>
				<Box>
					<Typography variant="overline" color="text.secondary">
						Working copy
					</Typography>
					<Typography sx={{fontFamily: 'ui-monospace, monospace', fontSize: 13, wordBreak: 'break-all'}}>{status.scope.root}</Typography>
				</Box>
				<Box>
					<Typography variant="overline" color="text.secondary">
						Build lease
					</Typography>
					<Typography>{status.lease === null ? 'No active owner' : `Owned until ${formatTimestamp(status.lease.expiresAt)}`}</Typography>
				</Box>
				<Box>
					<Typography variant="overline" color="text.secondary">
						Last error
					</Typography>
					<Typography color={status.lastError === null ? 'text.primary' : 'error.main'}>{status.lastError ?? 'None'}</Typography>
				</Box>
			</Stack>
		</CardContent>
	</Card>
);

const OverviewRecent = ({snapshot}: Readonly<{snapshot: ConsoleSnapshotType}>) => {
	const recent = snapshot.jobs.slice(0, 4);

	return (
		<Card>
			<CardContent>
				<Typography variant="h6" gutterBottom>
					Recent operations
				</Typography>
				{recent.length === 0 ? (
					<Typography variant="body2" color="text.secondary">
						No console operations have run yet.
					</Typography>
				) : (
					<Stack divider={<Divider flexItem />}>
						{recent.map((job) => (
							<Stack key={job.id} direction={{xs: 'column', sm: 'row'}} spacing={1} sx={{py: 1, justifyContent: 'space-between'}}>
								<Box>
									<Typography sx={{fontWeight: 600}}>{job.operation}</Typography>
									<Typography variant="caption" color="text.secondary">
										{formatTimestamp(job.createdAt)}
									</Typography>
								</Box>
								<Stack direction="row" spacing={1.5} sx={{alignItems: 'center'}}>
									<Chip
										size="small"
										label={job.state}
										color={job.state === 'succeeded' ? 'success' : job.state === 'failed' ? 'error' : job.state === 'running' ? 'warning' : 'default'}
									/>
									<Typography variant="body2" color="text.secondary" sx={{minWidth: 70, textAlign: 'right'}}>
										{formatDuration(job.durationMs)}
									</Typography>
								</Stack>
							</Stack>
						))}
					</Stack>
				)}
			</CardContent>
		</Card>
	);
};

export const OverviewPage = ({snapshot, busy, onOpenOperations, onRunUpdate}: OverviewPagePropsType) => (
	<Stack spacing={3}>
		<OverviewHero status={snapshot.status} busy={busy} onOpenOperations={onOpenOperations} onRunUpdate={onRunUpdate} />
		<OverviewMetrics status={snapshot.status} />
		<Grid container spacing={2}>
			<Grid size={{xs: 12, lg: 7}}>
				<OverviewBuild status={snapshot.status} />
			</Grid>
			<Grid size={{xs: 12, lg: 5}}>
				<OverviewScope status={snapshot.status} />
			</Grid>
		</Grid>
		<OverviewRecent snapshot={snapshot} />
	</Stack>
);
