import {
	Alert,
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Grid,
	Stack,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Typography,
} from '@mui/material';
import BuildIcon from '@mui/icons-material/Build';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import SpeedIcon from '@mui/icons-material/Speed';
import SettingsIcon from '@mui/icons-material/Settings';
import {type ConsoleJobType, type ConsoleOperationType, type ConsoleSnapshotType} from '../../transports/console/contracts.ts';
import {formatDuration, formatTimestamp} from './format.ts';

type OperationsPagePropsType = Readonly<{
	snapshot: ConsoleSnapshotType;
	activeJob: ConsoleJobType | null;
	error: string | null;
	resultJob: ConsoleJobType | null;
	onRun: (operation: ConsoleOperationType) => void;
	onShowResult: (job: ConsoleJobType | null) => void;
}>;

const OPERATION_CARDS: readonly Readonly<{operation: ConsoleOperationType; title: string; description: string; icon: typeof RefreshIcon}>[] = [
	{operation: 'update', title: 'Update index', description: 'Reuse the published generation when nothing changed, otherwise rebuild it.', icon: RefreshIcon},
	{operation: 'rebuild', title: 'Force rebuild', description: 'Publish a fresh generation even when hashes still match.', icon: BuildIcon},
	{operation: 'verify', title: 'Verify integrity', description: 'Check SQLite integrity, foreign keys, and persisted row counts.', icon: FactCheckIcon},
	{
		operation: 'mcp-install',
		title: 'Install MCP entry',
		description: 'Add or repair the project-local codeindex server registration. Uninstall remains CLI-only.',
		icon: SettingsIcon,
	},
	{operation: 'benchmark', title: 'Run benchmark', description: 'Measure build and warm query latency locally without model calls.', icon: SpeedIcon},
	{
		operation: 'verify-references',
		title: 'Verify references',
		description: 'Compare a deterministic symbol sample with the TypeScript language service.',
		icon: FactCheckIcon,
	},
];

const JobStateChip = ({job}: Readonly<{job: ConsoleJobType}>) => (
	<Chip
		size="small"
		label={job.state}
		color={job.state === 'succeeded' ? 'success' : job.state === 'failed' ? 'error' : job.state === 'running' ? 'warning' : 'default'}
	/>
);

const OperationGrid = ({activeJob, onRun}: Readonly<{activeJob: ConsoleJobType | null; onRun: (operation: ConsoleOperationType) => void}>) => (
	<Grid container spacing={2}>
		{OPERATION_CARDS.map((card) => (
			<Grid key={card.operation} size={{xs: 12, md: 6}}>
				<Card sx={{height: '100%'}}>
					<CardContent>
						<Stack direction="row" spacing={1.5} sx={{alignItems: 'flex-start'}}>
							<Box sx={{color: 'primary.main', mt: 0.5}}>
								<card.icon />
							</Box>
							<Box sx={{flex: 1}}>
								<Typography variant="h6">{card.title}</Typography>
								<Typography variant="body2" color="text.secondary" sx={{mb: 2}}>
									{card.description}
								</Typography>
								<Button
									variant="outlined"
									size="small"
									startIcon={<PlayArrowIcon />}
									disabled={activeJob !== null}
									onClick={() => {
										onRun(card.operation);
									}}
								>
									Run {card.operation}
								</Button>
							</Box>
						</Stack>
					</CardContent>
				</Card>
			</Grid>
		))}
	</Grid>
);

const JobsTable = ({jobs, onShowResult}: Readonly<{jobs: readonly ConsoleJobType[]; onShowResult: (job: ConsoleJobType) => void}>) => (
	<Card>
		<CardContent sx={{pb: 0}}>
			<Typography variant="h6">Recent jobs</Typography>
			<Typography variant="body2" color="text.secondary" sx={{mb: 1}}>
				Console operations are serialized to avoid competing builds.
			</Typography>
		</CardContent>
		<TableContainer>
			<Table size="small">
				<TableHead>
					<TableRow>
						<TableCell>Operation</TableCell>
						<TableCell>State</TableCell>
						<TableCell>Started</TableCell>
						<TableCell align="right">Duration</TableCell>
						<TableCell>Message</TableCell>
						<TableCell />
					</TableRow>
				</TableHead>
				<TableBody>
					{jobs.map((job) => (
						<TableRow key={job.id} hover>
							<TableCell>{job.operation}</TableCell>
							<TableCell>
								<JobStateChip job={job} />
							</TableCell>
							<TableCell>{formatTimestamp(job.startedAt ?? job.createdAt)}</TableCell>
							<TableCell align="right">{formatDuration(job.durationMs)}</TableCell>
							<TableCell sx={{maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{job.message ?? '—'}</TableCell>
							<TableCell align="right">
								<Button
									size="small"
									disabled={job.result === null}
									onClick={() => {
										onShowResult(job);
									}}
								>
									Result
								</Button>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableContainer>
	</Card>
);

export const OperationsPage = ({snapshot, activeJob, error, resultJob, onRun, onShowResult}: OperationsPagePropsType) => (
	<Stack spacing={3}>
		<Box>
			<Typography variant="h4">Operations</Typography>
			<Typography color="text.secondary">Run the non-destructive operational commands through the console.</Typography>
		</Box>
		{error === null ? null : <Alert severity="error">{error}</Alert>}
		{activeJob === null ? (
			<Alert severity="success">No operation is running.</Alert>
		) : (
			<Alert severity="info">
				<strong>{activeJob.operation}</strong> is {activeJob.state}. Jobs run one at a time.
			</Alert>
		)}
		<OperationGrid activeJob={activeJob} onRun={onRun} />
		{snapshot.jobs.length === 0 ? (
			<Alert severity="info">No jobs have run in this console session.</Alert>
		) : (
			<JobsTable jobs={snapshot.jobs} onShowResult={onShowResult} />
		)}
		<Dialog
			open={resultJob !== null}
			onClose={() => {
				onShowResult(null);
			}}
			maxWidth="md"
			fullWidth
		>
			<DialogTitle>{resultJob?.operation ?? 'Result'}</DialogTitle>
			<DialogContent dividers>
				<Box component="pre" sx={{m: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace', fontSize: 12}}>
					{JSON.stringify(resultJob?.result ?? null, null, 2)}
				</Box>
			</DialogContent>
			<DialogActions>
				<Button
					onClick={() => {
						onShowResult(null);
					}}
				>
					Close
				</Button>
			</DialogActions>
		</Dialog>
	</Stack>
);
