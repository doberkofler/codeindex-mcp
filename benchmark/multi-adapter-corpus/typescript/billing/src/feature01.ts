import {formatRecord} from './format.js';
import {type BillingRecord} from './model.js';

export const feature01 = (record: BillingRecord): string => `billing-${formatRecord(record)}`;

export const feature01Value = (record: BillingRecord): number => record.value + 1;
