import {Alert, Box, Button, Card, CardContent, CircularProgress, CssBaseline, Stack, ThemeProvider, Typography, useMediaQuery} from '@mui/material';
import {useMemo, useState} from 'react';
import {type AnalyticsToolType, type AnalyticsWindowType, type ConsoleJobType, type ConsoleOperationType} from '../../src/console/contracts.ts';
import {AnalyticsPage} from './AnalyticsPage.tsx';
import {AppShell, type ThemeModeType, type ViewType} from './AppShell.tsx';
import {clearToken, readToken, storeToken, useAnalytics, useRunOperation, useSnapshot} from './api.ts';
import {ConfigurationPage} from './ConfigurationPage.tsx';
import {OperationsPage} from './OperationsPage.tsx';
import {OverviewPage} from './OverviewPage.tsx';
import {createConsoleTheme} from './theme.ts';
import {TokenGate} from './TokenGate.tsx';

const THEME_KEY = 'code-index-console-theme';

const storedThemeMode = (): ThemeModeType => {
	const value = localStorage.getItem(THEME_KEY);
	return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
};

const ConnectedApp = ({
	token,
	themeMode,
	onThemeModeChange,
	onDisconnect,
}: Readonly<{
	token: string;
	themeMode: ThemeModeType;
	onThemeModeChange: (mode: ThemeModeType) => void;
	onDisconnect: () => void;
}>) => {
	const snapshot = useSnapshot(token);
	const [view, setView] = useState<ViewType>('overview');
	const [window, setWindow] = useState<AnalyticsWindowType>('24h');
	const [selectedTool, setSelectedTool] = useState<AnalyticsToolType | null>(null);
	const [resultJob, setResultJob] = useState<ConsoleJobType | null>(null);
	const analytics = useAnalytics(token, window, view === 'analytics');
	const operation = useRunOperation(token);

	if (snapshot.isPending) {
		return (
			<Box sx={{minHeight: '100dvh', display: 'grid', placeItems: 'center'}}>
				<Stack spacing={2} sx={{alignItems: 'center'}}>
					<CircularProgress />
					<Typography color="text.secondary">Connecting to the index...</Typography>
				</Stack>
			</Box>
		);
	}

	if (snapshot.data === undefined) {
		return (
			<Box sx={{minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2}}>
				<Card sx={{maxWidth: 560, width: '100%'}}>
					<CardContent sx={{p: 4}}>
						<Stack spacing={2}>
							<Typography variant="h5">Console connection failed</Typography>
							<Alert severity="error">{snapshot.error instanceof Error ? snapshot.error.message : 'The console did not respond.'}</Alert>
							<Button variant="contained" onClick={onDisconnect}>
								Enter a different token
							</Button>
						</Stack>
					</CardContent>
				</Card>
			</Box>
		);
	}

	const activeJob = snapshot.data.jobs.find((job) => job.state === 'queued' || job.state === 'running') ?? null;
	const run = (name: ConsoleOperationType): void => {
		setView('operations');
		operation.mutate(name);
	};

	return (
		<AppShell
			snapshot={snapshot.data}
			view={view}
			themeMode={themeMode}
			onViewChange={setView}
			onThemeModeChange={onThemeModeChange}
			onRefresh={() => {
				void snapshot.refetch();
				void analytics.refetch();
			}}
		>
			{view === 'overview' ? (
				<OverviewPage
					snapshot={snapshot.data}
					busy={activeJob !== null}
					onOpenOperations={() => {
						setView('operations');
					}}
					onRunUpdate={() => {
						run('update');
					}}
				/>
			) : null}
			{view === 'analytics' ? (
				<AnalyticsPage
					dashboard={analytics.data}
					window={window}
					loading={analytics.isFetching}
					error={analytics.error instanceof Error ? analytics.error.message : null}
					selectedTool={selectedTool}
					onWindowChange={setWindow}
					onSelectTool={setSelectedTool}
				/>
			) : null}
			{view === 'operations' ? (
				<OperationsPage
					snapshot={snapshot.data}
					activeJob={activeJob}
					error={operation.error instanceof Error ? operation.error.message : null}
					resultJob={resultJob}
					onRun={run}
					onShowResult={setResultJob}
				/>
			) : null}
			{view === 'configuration' ? <ConfigurationPage meta={snapshot.data.meta} /> : null}
		</AppShell>
	);
};

export const App = () => {
	const [token, setToken] = useState<string | null>(() => readToken());
	const [themeMode, setThemeMode] = useState<ThemeModeType>(() => storedThemeMode());
	const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
	const mode = themeMode === 'system' ? (prefersDark ? 'dark' : 'light') : themeMode;
	const theme = useMemo(() => createConsoleTheme(mode), [mode]);

	const changeThemeMode = (next: ThemeModeType): void => {
		localStorage.setItem(THEME_KEY, next);
		setThemeMode(next);
	};

	return (
		<ThemeProvider theme={theme}>
			<CssBaseline />
			{token === null ? (
				<TokenGate
					error={null}
					onSubmit={(value) => {
						storeToken(value);
						setToken(value);
					}}
				/>
			) : (
				<ConnectedApp
					token={token}
					themeMode={themeMode}
					onThemeModeChange={changeThemeMode}
					onDisconnect={() => {
						clearToken();
						setToken(null);
					}}
				/>
			)}
		</ThemeProvider>
	);
};
