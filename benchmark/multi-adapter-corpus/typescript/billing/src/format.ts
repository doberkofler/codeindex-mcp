import {type BillingRecord} from './model.js';

export const formatRecord = (record: BillingRecord): string => `${record.label}:${String(record.value)}`;
