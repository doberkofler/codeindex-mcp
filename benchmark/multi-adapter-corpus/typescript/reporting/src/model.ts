export type ReportingId = string;

export type ReportingRecord = {
	readonly id: ReportingId;
	readonly value: number;
	readonly label: string;
};

export const emptyRecord = (id: ReportingId): ReportingRecord => ({id, value: 0, label: 'empty'});
