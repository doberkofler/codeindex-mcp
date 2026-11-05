import {formatRecord} from './format.js';
import {type CatalogRecord} from './model.js';

export const feature02 = (record: CatalogRecord): string => `catalog-${formatRecord(record)}`;

export const feature02Value = (record: CatalogRecord): number => record.value + 2;
