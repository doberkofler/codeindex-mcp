import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App.tsx';

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {retry: false, refetchOnWindowFocus: false},
		mutations: {retry: false},
	},
});

const element = globalThis.document.querySelector('#root');

if (element === null) {
	throw new Error('Console root element is missing');
}

createRoot(element).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</StrictMode>,
);
