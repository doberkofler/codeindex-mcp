import {createTheme, type Theme} from '@mui/material/styles';

const common = {
	shape: {borderRadius: 14},
	typography: {
		fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
		h1: {fontWeight: 700, letterSpacing: '-0.035em'},
		h2: {fontWeight: 700, letterSpacing: '-0.025em'},
		h3: {fontWeight: 650, letterSpacing: '-0.02em'},
		h4: {fontWeight: 650, letterSpacing: '-0.015em'},
		button: {textTransform: 'none', fontWeight: 600},
	},
	components: {
		MuiCssBaseline: {
			styleOverrides: {
				body: {minHeight: '100dvh'},
				'*': {boxSizing: 'border-box'},
			},
		},
		MuiCard: {
			defaultProps: {elevation: 0},
			styleOverrides: {
				root: {
					backgroundImage: 'none',
					border: '1px solid',
					borderColor: 'divider',
				},
			},
		},
		MuiButton: {
			defaultProps: {disableElevation: true},
		},
		MuiPaper: {
			styleOverrides: {
				root: {backgroundImage: 'none'},
			},
		},
	},
} as const;

export const createConsoleTheme = (mode: 'light' | 'dark'): Theme =>
	createTheme({
		...common,
		palette:
			mode === 'light'
				? {
						mode,
						primary: {main: '#0f766e'},
						secondary: {main: '#7c3aed'},
						background: {default: '#f4f7f7', paper: '#ffffff'},
						text: {primary: '#102322', secondary: '#526665'},
						divider: 'rgba(15, 118, 110, 0.14)',
					}
				: {
						mode,
						primary: {main: '#5eead4'},
						secondary: {main: '#c4b5fd'},
						background: {default: '#071312', paper: '#0d1f1e'},
						text: {primary: '#e6fffb', secondary: '#93b4b0'},
						divider: 'rgba(94, 234, 212, 0.16)',
					},
	});
