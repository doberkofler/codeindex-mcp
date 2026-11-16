import {Alert, Box, Button, Card, CardContent, CircularProgress, CssBaseline, Stack, ThemeProvider, Typography, useMediaQuery} from '@mui/material';
import {useMemo, useState} from 'react';
import {type AnalyticsToolType, type AnalyticsWindowType, type ConsoleJobType, type ConsoleOperationRequestType} from '../../transports/console/contracts.ts';
import {AnalyticsPage} from './AnalyticsPage.tsx';
import {AppShell, type ThemeModeType, type ViewType} from './AppShell.tsx';
import {clearToken, readToken, storeToken, useAnalytics, useRunOperation, useSnapshot} from './api.ts';
import {OperationsPage} from './OperationsPage.tsx';
import {OverviewPage} from './OverviewPage.tsx';
import {createConsoleTheme} from './theme.ts';
import {TokenGate} from './TokenGate.tsx';

const THEME_KEY = 'code-index-console-theme';

const storedThemeMode = (): ThemeModeType => {
	const value = localStorage.getItem(THEME_KEY);
	return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
};

const ConnectionPending = () => (
	<Box sx={{minHeight: '100dvh', display: 'grid', placeItems: 'center'}}>
		<Stack spacing={2} sx={{alignItems: 'center'}}>
			<CircularProgress />
			<Typography color="text.secondary">Connecting to the index...</Typography>
		</Stack>
	</Box>
);

const ConnectionError = ({message, onDisconnect}: Readonly<{message: string; onDisconnect: () => void}>) => (
	<Box sx={{minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2}}>
		<Card sx={{maxWidth: 560, width: '100%'}}>
			<CardContent sx={{p: 4}}>
				<Stack spacing={2}>
					<Typography variant="h5">Console connection failed</Typography>
					<Alert severity="error">{message}</Alert>
					<Button variant="contained" onClick={onDisconnect}>
						Enter a different token
					</Button>
				</Stack>
			</CardContent>
		</Card>
	</Box>
);

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
		return <ConnectionPending />;
	}

	if (snapshot.data === undefined) {
		const message = snapshot.error instanceof Error ? snapshot.error.message : 'The console did not respond.';
		return <ConnectionError message={message} onDisconnect={onDisconnect} />;
	}

	const activeJob = snapshot.data.jobs.find((job) => job.state === 'queued' || job.state === 'running') ?? null;
	const busy = operation.isPending || activeJob !== null || snapshot.data.status.activity !== null;
	const run = (requestValue: ConsoleOperationRequestType): void => {
		setView('operations');
		operation.mutate(requestValue);
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
					busy={busy}
					onOpenOperations={() => {
						setView('operations');
					}}
					onRunUpdate={() => {
						run({operation: 'update', adapterId: null});
					}}
					onRunAdapter={(adapterId) => {
						run({operation: 'update', adapterId});
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
					status={snapshot.data.status}
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
					busy={busy}
					onShowResult={setResultJob}
				/>
			) : null}
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
