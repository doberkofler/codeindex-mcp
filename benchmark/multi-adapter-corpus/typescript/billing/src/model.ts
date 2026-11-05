export type BillingId = string;

export type BillingRecord = {
	readonly id: BillingId;
	readonly value: number;
	readonly label: string;
};

export const emptyRecord = (id: BillingId): BillingRecord => ({id, value: 0, label: 'empty'});
