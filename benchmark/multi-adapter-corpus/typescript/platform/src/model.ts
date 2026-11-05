export type PlatformId = string;

export type PlatformRecord = {
	readonly id: PlatformId;
	readonly value: number;
	readonly label: string;
};

export const emptyRecord = (id: PlatformId): PlatformRecord => ({id, value: 0, label: 'empty'});
