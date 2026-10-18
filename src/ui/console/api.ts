import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
	type AnalyticsDashboardType,
	type AnalyticsWindowType,
	type ConsoleJobType,
	type ConsoleOperationType,
	type ConsoleSnapshotType,
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

const request = async <ValueType>(path: string, token: string, init?: RequestInit): Promise<ValueType> => {
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
	return payload as ValueType;
};

export const useSnapshot = (token: string) =>
	useQuery({
		queryKey: ['snapshot', token],
		queryFn: () => request<ConsoleSnapshotType>('/api/snapshot', token),
		refetchInterval: 2_000,
	});

export const useAnalytics = (token: string, window: AnalyticsWindowType, enabled: boolean) =>
	useQuery({
		queryKey: ['analytics', token, window],
		queryFn: () => request<AnalyticsDashboardType>(`/api/analytics?window=${window}`, token),
		refetchInterval: 15_000,
		enabled,
	});

export const useRunOperation = (token: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (operation: ConsoleOperationType) =>
			request<{job: ConsoleJobType}>('/api/jobs', token, {
				method: 'POST',
				body: JSON.stringify({operation}),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({queryKey: ['snapshot', token]});
		},
	});
};
