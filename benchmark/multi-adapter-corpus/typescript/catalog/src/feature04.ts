import {formatRecord} from './format.js';
import {type CatalogRecord} from './model.js';

export const feature04 = (record: CatalogRecord): string => `catalog-${formatRecord(record)}`;

export const feature04Value = (record: CatalogRecord): number => record.value + 4;
