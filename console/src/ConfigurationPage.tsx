import {Alert, Box, Card, CardContent, Chip, Divider, Grid, Stack, Typography} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import SettingsIcon from '@mui/icons-material/Settings';
import {type ConsoleMetaType} from '../../src/console/contracts.ts';

type ConfigurationPagePropsType = Readonly<{
	meta: ConsoleMetaType;
}>;

const Field = ({label, value}: Readonly<{label: string; value: string}>) => (
	<Box>
		<Typography variant="overline" color="text.secondary">
			{label}
		</Typography>
		<Typography sx={{fontFamily: 'ui-monospace, monospace', fontSize: 13, wordBreak: 'break-all'}}>{value}</Typography>
	</Box>
);

const AbsentCard = () => (
	<Card>
		<CardContent>
			<Typography variant="h6" gutterBottom>
				Intentionally absent
			</Typography>
			<Typography variant="body2" color="text.secondary">
				The console does not expose cleanup deletion or MCP uninstall. Run those explicitly from the CLI after confirming their impact.
			</Typography>
		</CardContent>
	</Card>
);

export const ConfigurationPage = ({meta}: ConfigurationPagePropsType) => (
	<Stack spacing={3}>
		<Box>
			<Typography variant="h4">Configuration</Typography>
			<Typography color="text.secondary">Resolved runtime configuration and console security boundaries.</Typography>
		</Box>
		<Grid container spacing={2}>
			<Grid size={{xs: 12, lg: 7}}>
				<Card sx={{height: '100%'}}>
					<CardContent>
						<Stack direction="row" spacing={1} sx={{mb: 2, alignItems: 'center'}}>
							<SettingsIcon color="primary" />
							<Typography variant="h6">Index</Typography>
						</Stack>
						<Stack spacing={2} divider={<Divider flexItem />}>
							<Field label="Working copy" value={meta.rootDir} />
							<Field label="project file" value={meta.projectFilePath} />
							<Field label="Database" value={meta.databasePath} />
							<Field label="Analytics log" value={meta.analyticsPath} />
							<Stack direction="row" spacing={1}>
								<Chip size="small" label={`project ${meta.projectId}`} />
								<Chip size="small" label={`schema ${meta.schemaVersion}`} />
								<Chip
									size="small"
									label={`analytics ${meta.analyticsEnabled ? 'enabled' : 'disabled'}`}
									color={meta.analyticsEnabled ? 'success' : 'default'}
								/>
							</Stack>
						</Stack>
					</CardContent>
				</Card>
			</Grid>
			<Grid size={{xs: 12, lg: 5}}>
				<Card sx={{height: '100%'}}>
					<CardContent>
						<Stack direction="row" spacing={1} sx={{mb: 2, alignItems: 'center'}}>
							<LockIcon color="primary" />
							<Typography variant="h6">Security boundary</Typography>
						</Stack>
						<Stack spacing={1.5} divider={<Divider flexItem />}>
							<Stack direction="row" sx={{justifyContent: 'space-between'}}>
								<Typography color="text.secondary">Listener</Typography>
								<Typography>Loopback only</Typography>
							</Stack>
							<Stack direction="row" sx={{justifyContent: 'space-between'}}>
								<Typography color="text.secondary">Authentication</Typography>
								<Typography>Per-run bearer token</Typography>
							</Stack>
							<Stack direction="row" sx={{justifyContent: 'space-between'}}>
								<Typography color="text.secondary">Origin policy</Typography>
								<Typography>Loopback only</Typography>
							</Stack>
							<Stack direction="row" sx={{justifyContent: 'space-between'}}>
								<Typography color="text.secondary">Console version</Typography>
								<Typography>
									{meta.program} {meta.version}
								</Typography>
							</Stack>
							<Stack direction="row" sx={{justifyContent: 'space-between'}}>
								<Typography color="text.secondary">Node</Typography>
								<Typography>{meta.nodeVersion}</Typography>
							</Stack>
						</Stack>
					</CardContent>
				</Card>
			</Grid>
		</Grid>
		<Card>
			<CardContent>
				<Typography variant="h6" gutterBottom>
					MCP lifecycle
				</Typography>
				<Alert severity="info" sx={{mb: 2}}>
					OpenCode owns the MCP child process. The console can inspect and rebuild the index, but it cannot start, stop, or restart that process.
				</Alert>
				<Stack spacing={1}>
					<Typography variant="body2" color="text.secondary">
						Install or repair the registration from Operations. Remove it with:
					</Typography>
					<Box component="pre" sx={{m: 0, p: 2, borderRadius: 2, bgcolor: 'action.hover', fontFamily: 'ui-monospace, monospace', fontSize: 13}}>
						pnpm mcp:uninstall
					</Box>
					<Typography variant="body2" color="text.secondary">
						After rebuilding the server, disconnect and reconnect <code>codeindex</code> in OpenCode&apos;s <code>/mcps</code> view so the new tool catalog and
						instructions are loaded.
					</Typography>
				</Stack>
			</CardContent>
		</Card>
		<AbsentCard />
	</Stack>
);
