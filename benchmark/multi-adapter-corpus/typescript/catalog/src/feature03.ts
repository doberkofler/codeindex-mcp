import {formatRecord} from './format.js';
import {type CatalogRecord} from './model.js';

export const feature03 = (record: CatalogRecord): string => `catalog-${formatRecord(record)}`;

export const feature03Value = (record: CatalogRecord): number => record.value + 3;
