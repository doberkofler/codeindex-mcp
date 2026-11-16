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
	FormControl,
	InputLabel,
	MenuItem,
	Select,
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
import RefreshIcon from '@mui/icons-material/Refresh';
import {useState} from 'react';
import {type ConsoleJobType, type ConsoleOperationRequestType, type ConsoleSnapshotType} from '../../transports/console/contracts.ts';
import {formatDuration, formatNumber, formatTimestamp} from './format.ts';
import {rememberOverlayTrigger, restoreOverlayTrigger} from './overlayFocus.ts';

type OperationsPagePropsType = Readonly<{
	snapshot: ConsoleSnapshotType;
	activeJob: ConsoleJobType | null;
	busy: boolean;
	error: string | null;
	resultJob: ConsoleJobType | null;
	onRun: (requestValue: ConsoleOperationRequestType) => void;
	onShowResult: (job: ConsoleJobType | null) => void;
}>;

const JobStateChip = ({job}: Readonly<{job: ConsoleJobType}>) => (
	<Chip
		size="small"
		label={job.state}
		color={job.state === 'succeeded' ? 'success' : job.state === 'failed' ? 'error' : job.state === 'running' ? 'warning' : 'default'}
	/>
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

const ResultSummary = ({job}: Readonly<{job: ConsoleJobType}>) => {
	const {result} = job;

	if (!isRecord(result)) {
		return <Typography color="text.secondary">No structured result.</Typography>;
	}

	const generation = typeof result['generationId'] === 'string' ? result['generationId'] : null;
	const outcome = typeof result['outcome'] === 'string' ? result['outcome'] : null;
	const integrity = typeof result['integrity'] === 'string' ? result['integrity'] : null;

	return (
		<Stack spacing={2}>
			{generation === null ? null : (
				<Box>
					<Typography variant="overline" color="text.secondary">
						Generation
					</Typography>
					<Typography sx={{fontFamily: 'ui-monospace, monospace'}}>{generation}</Typography>
				</Box>
			)}
			{outcome === null ? null : <Alert severity={outcome === 'superseded' ? 'warning' : 'success'}>Outcome: {outcome}</Alert>}
			{integrity === null ? null : <Alert severity={integrity === 'ok' ? 'success' : 'error'}>Storage integrity: {integrity}</Alert>}
			{'fileCount' in result ? (
				<Typography>
					{formatNumber(Number(result['fileCount']))} files · {formatNumber(Number(result['symbolCount']))} symbols ·{' '}
					{formatNumber(Number(result['occurrenceCount']))} occurrences
				</Typography>
			) : null}
		</Stack>
	);
};

const JobsTable = ({jobs, onShowResult}: Readonly<{jobs: readonly ConsoleJobType[]; onShowResult: (job: ConsoleJobType) => void}>) => (
	<Card>
		<CardContent sx={{pb: 0}}>
			<Typography variant="h6">Maintenance history</Typography>
			<Typography variant="body2" color="text.secondary" sx={{mb: 1}}>
				Manual commands run one at a time; watcher-driven indexing appears in the global activity banner.
			</Typography>
		</CardContent>
		<TableContainer>
			<Table size="small">
				<TableHead>
					<TableRow>
						<TableCell>Command</TableCell>
						<TableCell>Target</TableCell>
						<TableCell>State</TableCell>
						<TableCell>Phase</TableCell>
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
							<TableCell>{job.adapterId ?? 'workspace'}</TableCell>
							<TableCell>
								<JobStateChip job={job} />
							</TableCell>
							<TableCell>{job.phase ?? '—'}</TableCell>
							<TableCell>{formatTimestamp(job.startedAt ?? job.createdAt)}</TableCell>
							<TableCell align="right">{formatDuration(job.durationMs)}</TableCell>
							<TableCell sx={{maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{job.message ?? '—'}</TableCell>
							<TableCell align="right">
								<Button
									size="small"
									disabled={job.result === null}
									onClick={(event) => {
										rememberOverlayTrigger(event.currentTarget);
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

type MaintenanceControlsPropsType = Readonly<{
	adapters: ConsoleSnapshotType['status']['scope']['adapters'];
	target: string;
	busy: boolean;
	onTargetChange: (target: string) => void;
	onRun: (requestValue: ConsoleOperationRequestType) => void;
	onConfirmRebuild: (trigger: HTMLButtonElement) => void;
}>;

const MaintenanceControls = ({adapters, target, busy, onTargetChange, onRun, onConfirmRebuild}: MaintenanceControlsPropsType) => {
	const adapterId = target === 'workspace' ? null : target;

	return (
		<Card>
			<CardContent>
				<Stack direction={{xs: 'column', md: 'row'}} spacing={2} sx={{alignItems: {md: 'center'}}}>
					<FormControl size="small" sx={{minWidth: 240}}>
						<InputLabel id="maintenance-target-label">Target</InputLabel>
						<Select
							labelId="maintenance-target-label"
							label="Target"
							value={target}
							onChange={(event) => {
								onTargetChange(event.target.value);
							}}
						>
							<MenuItem value="workspace">All adapters</MenuItem>
							{adapters.map((adapter) => (
								<MenuItem key={adapter.id} value={adapter.id}>
									{adapter.displayName}
								</MenuItem>
							))}
						</Select>
					</FormControl>
					<Button
						variant="contained"
						startIcon={<RefreshIcon />}
						disabled={busy}
						onClick={() => {
							onRun({operation: 'update', adapterId});
						}}
					>
						Sync now
					</Button>
					<Button
						variant="outlined"
						color="warning"
						startIcon={<BuildIcon />}
						disabled={busy}
						onClick={(event) => {
							onConfirmRebuild(event.currentTarget);
						}}
					>
						Force rebuild
					</Button>
					<Button
						variant="outlined"
						startIcon={<FactCheckIcon />}
						disabled={busy}
						onClick={() => {
							onRun({operation: 'verify', adapterId: null});
						}}
					>
						Verify storage
					</Button>
				</Stack>
			</CardContent>
		</Card>
	);
};

const RebuildDialog = ({
	open,
	adapterId,
	onClose,
	onConfirm,
}: Readonly<{open: boolean; adapterId: string | null; onClose: () => void; onConfirm: () => void}>) => (
	<Dialog open={open} onClose={onClose}>
		<DialogTitle>Force rebuild?</DialogTitle>
		<DialogContent>
			<Typography>
				This bypasses fact reuse for <strong>{adapterId ?? 'all adapters'}</strong>. Use it only for recovery or diagnosis.
			</Typography>
		</DialogContent>
		<DialogActions>
			<Button onClick={onClose}>Cancel</Button>
			<Button color="warning" variant="contained" onClick={onConfirm}>
				Rebuild
			</Button>
		</DialogActions>
	</Dialog>
);

const ResultDialog = ({job, onClose}: Readonly<{job: ConsoleJobType | null; onClose: () => void}>) => (
	<Dialog open={job !== null} onClose={onClose} maxWidth="sm" fullWidth>
		<DialogTitle>{job === null ? 'Result' : `${job.operation}: ${job.adapterId ?? 'workspace'}`}</DialogTitle>
		<DialogContent dividers>{job === null ? null : <ResultSummary job={job} />}</DialogContent>
		<DialogActions>
			<Button onClick={onClose}>Close</Button>
		</DialogActions>
	</Dialog>
);

export const OperationsPage = ({snapshot, activeJob, busy, error, resultJob, onRun, onShowResult}: OperationsPagePropsType) => {
	const [target, setTarget] = useState<string>('workspace');
	const [confirmRebuild, setConfirmRebuild] = useState(false);
	const adapterId = target === 'workspace' ? null : target;
	const closeRebuild = (): void => {
		restoreOverlayTrigger();
		setConfirmRebuild(false);
	};
	const closeResult = (): void => {
		restoreOverlayTrigger();
		onShowResult(null);
	};

	return (
		<Stack spacing={3}>
			<Box>
				<Typography variant="h4">Maintenance</Typography>
				<Typography color="text.secondary">Manual recovery and storage checks. Normal updates are automatic.</Typography>
			</Box>
			{error === null ? null : <Alert severity="error">{error}</Alert>}
			{activeJob === null ? null : (
				<Alert severity="info">
					<strong>{activeJob.operation}</strong> for {activeJob.adapterId ?? 'workspace'} is {activeJob.phase ?? activeJob.state}.
				</Alert>
			)}
			<MaintenanceControls
				adapters={snapshot.status.scope.adapters}
				target={target}
				busy={busy}
				onTargetChange={setTarget}
				onRun={onRun}
				onConfirmRebuild={(trigger) => {
					rememberOverlayTrigger(trigger);
					setConfirmRebuild(true);
				}}
			/>
			{snapshot.jobs.length === 0 ? (
				<Alert severity="info">No manual maintenance has run in this console session.</Alert>
			) : (
				<JobsTable jobs={snapshot.jobs} onShowResult={onShowResult} />
			)}
			<RebuildDialog
				open={confirmRebuild}
				adapterId={adapterId}
				onClose={closeRebuild}
				onConfirm={() => {
					closeRebuild();
					onRun({operation: 'rebuild', adapterId});
				}}
			/>
			<ResultDialog job={resultJob} onClose={closeResult} />
		</Stack>
	);
};
