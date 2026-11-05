import {formatRecord} from './format.js';
import {type BillingRecord} from './model.js';

export const feature04 = (record: BillingRecord): string => `billing-${formatRecord(record)}`;

export const feature04Value = (record: BillingRecord): number => record.value + 4;
