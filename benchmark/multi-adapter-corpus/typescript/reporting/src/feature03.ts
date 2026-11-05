import {formatRecord} from './format.js';
import {type ReportingRecord} from './model.js';

export const feature03 = (record: ReportingRecord): string => `reporting-${formatRecord(record)}`;

export const feature03Value = (record: ReportingRecord): number => record.value + 3;
