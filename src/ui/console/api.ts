import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {z} from 'zod';
import {
	analyticsDashboardSchema,
	type AnalyticsWindowType,
	consoleJobResponseSchema,
	consoleSnapshotSchema,
	type ConsoleOperationType,
} from '../../transports/console/contracts.ts';

const TOKEN_KEY = 'code-index-console-token';

const tokenFromHash = (): string | null => {
	const match = /(?:^#|&)token=(?<token>[^&]+)/u.exec(globalThis.location.hash);
	return Object.values(match?.groups ?? {}).at(0) ?? null;
};

export const readToken = (): string | null => {
	const fromHash = tokenFromHash();

	if (fromHash !== null) {
		globalThis.sessionStorage.setItem(TOKEN_KEY, fromHash);
		globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}`);
		return fromHash;
	}

	return globalThis.sessionStorage.getItem(TOKEN_KEY);
};

export const storeToken = (token: string): void => {
	globalThis.sessionStorage.setItem(TOKEN_KEY, token);
};

export const clearToken = (): void => {
	globalThis.sessionStorage.removeItem(TOKEN_KEY);
};

const request = async <SchemaType extends z.ZodType>(path: string, token: string, schema: SchemaType, init?: RequestInit): Promise<z.infer<SchemaType>> => {
	const response = await fetch(path, {
		...init,
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${token}`,
			...(init?.body === undefined ? {} : {'content-type': 'application/json'}),
		},
	});

	if (!response.ok) {
		const payload: unknown = await response.json().catch(() => null);
		const message =
			typeof payload === 'object' &&
			payload !== null &&
			'error' in payload &&
			typeof payload.error === 'object' &&
			payload.error !== null &&
			'message' in payload.error
				? String(payload.error.message)
				: `Request failed with ${response.status}`;
		throw new Error(message);
	}

	const payload: unknown = await response.json();
	const parsed = schema.safeParse(payload);

	if (!parsed.success) {
		throw new Error(`Unexpected console response:\n${z.prettifyError(parsed.error)}`);
	}

	return parsed.data;
};

export const useSnapshot = (token: string) =>
	useQuery({
		queryKey: ['snapshot', token],
		queryFn: () => request('/api/snapshot', token, consoleSnapshotSchema),
		refetchInterval: 2_000,
	});

export const useAnalytics = (token: string, window: AnalyticsWindowType, enabled: boolean) =>
	useQuery({
		queryKey: ['analytics', token, window],
		queryFn: () => request(`/api/analytics?window=${window}`, token, analyticsDashboardSchema),
		refetchInterval: 15_000,
		enabled,
	});

export const useRunOperation = (token: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (operation: ConsoleOperationType) =>
			request('/api/jobs', token, consoleJobResponseSchema, {
				method: 'POST',
				body: JSON.stringify({operation}),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({queryKey: ['snapshot', token]});
		},
	});
};
