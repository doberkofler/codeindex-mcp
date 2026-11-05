import {formatRecord} from './format.js';
import {type CatalogRecord} from './model.js';

export const feature05 = (record: CatalogRecord): string => `catalog-${formatRecord(record)}`;

export const feature05Value = (record: CatalogRecord): number => record.value + 5;
