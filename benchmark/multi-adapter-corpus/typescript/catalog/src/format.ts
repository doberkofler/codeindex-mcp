import {type CatalogRecord} from './model.js';

export const formatRecord = (record: CatalogRecord): string => `${record.label}:${String(record.value)}`;
