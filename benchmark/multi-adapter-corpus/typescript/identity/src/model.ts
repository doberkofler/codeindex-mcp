export type IdentityId = string;

export type IdentityRecord = {
	readonly id: IdentityId;
	readonly value: number;
	readonly label: string;
};

export const emptyRecord = (id: IdentityId): IdentityRecord => ({id, value: 0, label: 'empty'});
