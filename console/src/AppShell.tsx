import {
	AppBar,
	Box,
	Divider,
	Drawer,
	IconButton,
	List,
	ListItemButton,
	ListItemIcon,
	ListItemText,
	Stack,
	Toolbar,
	Tooltip,
	Typography,
	alpha,
	useMediaQuery,
	useTheme,
} from '@mui/material';
import BrightnessAutoIcon from '@mui/icons-material/BrightnessAuto';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import InsightsIcon from '@mui/icons-material/Insights';
import LightModeIcon from '@mui/icons-material/LightMode';
import MenuIcon from '@mui/icons-material/Menu';
import RefreshIcon from '@mui/icons-material/Refresh';
import SettingsIcon from '@mui/icons-material/Settings';
import TerminalIcon from '@mui/icons-material/Terminal';
import {useState, type ReactNode} from 'react';
import {type ConsoleSnapshotType} from '../../src/console/contracts.ts';
import {StatusChip} from './components/StatusChip.tsx';
import {shortId} from './format.ts';

export type ViewType = 'overview' | 'analytics' | 'operations' | 'configuration';
export type ThemeModeType = 'system' | 'light' | 'dark';

type AppShellPropsType = Readonly<{
	snapshot: ConsoleSnapshotType;
	view: ViewType;
	themeMode: ThemeModeType;
	children: ReactNode;
	onViewChange: (view: ViewType) => void;
	onThemeModeChange: (mode: ThemeModeType) => void;
	onRefresh: () => void;
}>;

const NAV_ITEMS: readonly Readonly<{view: ViewType; label: string; icon: typeof DashboardIcon}>[] = [
	{view: 'overview', label: 'Overview', icon: DashboardIcon},
	{view: 'analytics', label: 'Analytics', icon: InsightsIcon},
	{view: 'operations', label: 'Operations', icon: TerminalIcon},
	{view: 'configuration', label: 'Configuration', icon: SettingsIcon},
];

const nextThemeMode = (mode: ThemeModeType): ThemeModeType => (mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system');
const themeIcon = (mode: ThemeModeType) => (mode === 'system' ? <BrightnessAutoIcon /> : mode === 'light' ? <LightModeIcon /> : <DarkModeIcon />);

const Brand = () => (
	<Stack direction="row" spacing={1.5} sx={{px: 2.5, py: 2, alignItems: 'center'}}>
		<Box
			sx={{
				width: 38,
				height: 38,
				borderRadius: 2.5,
				display: 'grid',
				placeItems: 'center',
				color: 'primary.contrastText',
				background: (theme) => `linear-gradient(140deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
				fontWeight: 800,
				letterSpacing: '-0.08em',
			}}
		>
			CI
		</Box>
		<Box>
			<Typography sx={{fontWeight: 750, lineHeight: 1.1}}>Code Index</Typography>
			<Typography variant="caption" color="text.secondary">
				Operations console
			</Typography>
		</Box>
	</Stack>
);

const Navigation = ({view, onViewChange}: Readonly<{view: ViewType; onViewChange: (view: ViewType) => void}>) => (
	<List sx={{px: 1.5}}>
		{NAV_ITEMS.map((item) => (
			<ListItemButton
				key={item.view}
				selected={view === item.view}
				onClick={() => {
					onViewChange(item.view);
				}}
				sx={{
					borderRadius: 2,
					mb: 0.5,
					'&.Mui-selected': {
						bgcolor: (theme) => alpha(theme.palette.primary.main, 0.12),
						'&:hover': {bgcolor: (theme) => alpha(theme.palette.primary.main, 0.16)},
					},
				}}
			>
				<ListItemIcon sx={{minWidth: 38}}>
					<item.icon fontSize="small" />
				</ListItemIcon>
				<ListItemText primary={item.label} slotProps={{primary: {sx: {fontWeight: 600}}}} />
			</ListItemButton>
		))}
	</List>
);

const DrawerContent = ({snapshot, view, onViewChange}: Readonly<{snapshot: ConsoleSnapshotType; view: ViewType; onViewChange: (view: ViewType) => void}>) => (
	<Stack sx={{height: '100%'}}>
		<Brand />
		<Divider />
		<Navigation view={view} onViewChange={onViewChange} />
		<Box sx={{flex: 1}} />
		<Divider />
		<Box sx={{p: 2.5}}>
			<StatusChip status={snapshot.status} />
			<Typography variant="caption" color="text.secondary" sx={{display: 'block', mt: 1}}>
				Generation {shortId(snapshot.status.generationId)}
			</Typography>
			<Typography variant="caption" color="text.secondary" sx={{display: 'block'}}>
				v{snapshot.meta.version} · schema {snapshot.meta.schemaVersion}
			</Typography>
		</Box>
	</Stack>
);

export const AppShell = ({snapshot, view, themeMode, children, onViewChange, onThemeModeChange, onRefresh}: AppShellPropsType) => {
	const theme = useTheme();
	const desktop = useMediaQuery(theme.breakpoints.up('md'));
	const [mobileOpen, setMobileOpen] = useState(false);

	return (
		<Box
			sx={{
				minHeight: '100dvh',
				bgcolor: 'background.default',
				backgroundImage: (current) =>
					`radial-gradient(circle at 95% 0%, ${alpha(current.palette.primary.main, current.palette.mode === 'dark' ? 0.12 : 0.08)}, transparent 34%), radial-gradient(circle at 0% 100%, ${alpha(
						current.palette.secondary.main,
						current.palette.mode === 'dark' ? 0.1 : 0.05,
					)}, transparent 30%)`,
			}}
		>
			{desktop ? (
				<Drawer
					variant="permanent"
					sx={{
						width: 264,
						flexShrink: 0,
						'& .MuiDrawer-paper': {width: 264, boxSizing: 'border-box', borderRight: '1px solid', borderColor: 'divider', bgcolor: 'background.paper'},
					}}
				>
					<DrawerContent snapshot={snapshot} view={view} onViewChange={onViewChange} />
				</Drawer>
			) : null}
			<Box sx={{ml: {md: '264px'}}}>
				<AppBar
					position="sticky"
					color="transparent"
					elevation={0}
					sx={{backdropFilter: 'blur(14px)', bgcolor: (current) => alpha(current.palette.background.default, 0.82)}}
				>
					<Toolbar sx={{gap: 1}}>
						{desktop ? null : (
							<IconButton
								edge="start"
								aria-label="Open navigation"
								onClick={() => {
									setMobileOpen(true);
								}}
							>
								<MenuIcon />
							</IconButton>
						)}
						<Typography sx={{flex: 1, fontWeight: 700}}>{NAV_ITEMS.find((item) => item.view === view)?.label ?? 'Code Index'}</Typography>
						<Box sx={{display: {xs: 'none', sm: 'block'}}}>
							<StatusChip status={snapshot.status} />
						</Box>
						<Tooltip title={`Theme: ${themeMode}`}>
							<IconButton
								onClick={() => {
									onThemeModeChange(nextThemeMode(themeMode));
								}}
								aria-label="Change color theme"
							>
								{themeIcon(themeMode)}
							</IconButton>
						</Tooltip>
						<Tooltip title="Refresh now">
							<IconButton onClick={onRefresh} aria-label="Refresh console data">
								<RefreshIcon />
							</IconButton>
						</Tooltip>
					</Toolbar>
				</AppBar>
				<Box component="main" sx={{p: {xs: 2, sm: 3, lg: 4}, maxWidth: 1_600, mx: 'auto'}}>
					{children}
				</Box>
			</Box>
			<Drawer
				open={mobileOpen}
				onClose={() => {
					setMobileOpen(false);
				}}
			>
				<Box
					sx={{width: 280}}
					onClick={() => {
						setMobileOpen(false);
					}}
				>
					<DrawerContent snapshot={snapshot} view={view} onViewChange={onViewChange} />
				</Box>
			</Drawer>
		</Box>
	);
};
