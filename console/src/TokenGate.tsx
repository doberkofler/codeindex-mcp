import {Alert, Box, Button, Card, CardContent, Stack, TextField, Typography} from '@mui/material';
import KeyIcon from '@mui/icons-material/Key';
import {useState} from 'react';

type TokenGatePropsType = Readonly<{
	error: string | null;
	onSubmit: (token: string) => void;
}>;

export const TokenGate = ({error, onSubmit}: TokenGatePropsType) => {
	const [value, setValue] = useState('');
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (): void => {
		const token = value.trim();

		if (token.length === 0) {
			setLocalError('Enter the token printed by the console command.');
			return;
		}

		setLocalError(null);
		onSubmit(token);
	};

	return (
		<Box sx={{minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'background.default'}}>
			<Card sx={{width: '100%', maxWidth: 520}}>
				<CardContent sx={{p: 4}}>
					<Stack spacing={2.5}>
						<Stack direction="row" spacing={1.5} sx={{alignItems: 'center'}}>
							<Box sx={{width: 44, height: 44, borderRadius: 2.5, display: 'grid', placeItems: 'center', bgcolor: 'action.hover', color: 'primary.main'}}>
								<KeyIcon />
							</Box>
							<Box>
								<Typography variant="h5">Connect to the console</Typography>
								<Typography variant="body2" color="text.secondary">
									This console is protected by a per-run token.
								</Typography>
							</Box>
						</Stack>
						{error === null ? null : <Alert severity="error">{error}</Alert>}
						<TextField
							label="Console token"
							value={value}
							onChange={(event) => {
								setValue(event.target.value);
							}}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									submit();
								}
							}}
							error={localError !== null}
							helperText={localError ?? 'Use the token in the URL fragment or terminal output.'}
							fullWidth
							autoFocus
						/>
						<Button variant="contained" size="large" onClick={submit}>
							Open console
						</Button>
						<Typography variant="caption" color="text.secondary">
							The token is stored in this tab&apos;s session storage and sent as a bearer token. The server binds to loopback only.
						</Typography>
					</Stack>
				</CardContent>
			</Card>
		</Box>
	);
};
