import {formatRecord} from './format.js';
import {type BillingRecord} from './model.js';

export const feature05 = (record: BillingRecord): string => `billing-${formatRecord(record)}`;

export const feature05Value = (record: BillingRecord): number => record.value + 5;
