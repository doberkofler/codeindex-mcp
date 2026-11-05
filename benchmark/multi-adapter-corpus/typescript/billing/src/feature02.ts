import {formatRecord} from './format.js';
import {type BillingRecord} from './model.js';

export const feature02 = (record: BillingRecord): string => `billing-${formatRecord(record)}`;

export const feature02Value = (record: BillingRecord): number => record.value + 2;
