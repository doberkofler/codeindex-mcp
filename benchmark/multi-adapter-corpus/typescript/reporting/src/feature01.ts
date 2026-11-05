import {formatRecord} from './format.js';
import {type ReportingRecord} from './model.js';

export const feature01 = (record: ReportingRecord): string => `reporting-${formatRecord(record)}`;

export const feature01Value = (record: ReportingRecord): number => record.value + 1;
