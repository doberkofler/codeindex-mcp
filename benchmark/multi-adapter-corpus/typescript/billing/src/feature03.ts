import {formatRecord} from './format.js';
import {type BillingRecord} from './model.js';

export const feature03 = (record: BillingRecord): string => `billing-${formatRecord(record)}`;

export const feature03Value = (record: BillingRecord): number => record.value + 3;
