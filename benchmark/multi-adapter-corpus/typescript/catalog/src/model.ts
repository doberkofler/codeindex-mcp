export type CatalogId = string;

export type CatalogRecord = {
	readonly id: CatalogId;
	readonly value: number;
	readonly label: string;
};

export const emptyRecord = (id: CatalogId): CatalogRecord => ({id, value: 0, label: 'empty'});
