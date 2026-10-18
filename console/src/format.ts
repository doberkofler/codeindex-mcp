const numberFormatter = new Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1});
const fullNumberFormatter = new Intl.NumberFormat();

export const formatNumber = (value: number): string => (Math.abs(value) < 10_000 ? fullNumberFormatter.format(value) : numberFormatter.format(value));

export const formatDuration = (value: number | null): string => {
	if (value === null) {
		return '—';
	}

	if (value < 1000) {
		return `${Math.round(value)} ms`;
	}

	return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
};

export const formatBytes = (value: number): string => {
	if (value < 1024) {
		return `${value} B`;
	}

	const units = ['KB', 'MB', 'GB'];
	let size = value / 1024;
	let unit = 'KB';

	for (const candidate of units.slice(1)) {
		if (size < 1024) {
			break;
		}

		size /= 1024;
		unit = candidate;
	}

	return `${size.toFixed(size < 10 ? 1 : 0)} ${unit}`;
};

export const formatPercent = (value: number): string => `${(value * 100).toFixed(value > 0 && value < 0.01 ? 1 : 2)}%`;

export const formatTimestamp = (value: string | null): string =>
	value === null ? '—' : new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'medium'}).format(new Date(value));

export const formatClock = (value: string): string => new Intl.DateTimeFormat(undefined, {timeStyle: 'short'}).format(new Date(value));

export const shortId = (value: string | null): string => (value === null ? 'none' : value.slice(0, 8));
