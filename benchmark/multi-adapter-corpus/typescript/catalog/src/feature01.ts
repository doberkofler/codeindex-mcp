import {formatRecord} from './format.js';
import {type CatalogRecord} from './model.js';

export const feature01 = (record: CatalogRecord): string => `catalog-${formatRecord(record)}`;

export const feature01Value = (record: CatalogRecord): number => record.value + 1;
