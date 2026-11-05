import {formatRecord} from './format.js';
import {type ReportingRecord} from './model.js';

export const feature05 = (record: ReportingRecord): string => `reporting-${formatRecord(record)}`;

export const feature05Value = (record: ReportingRecord): number => record.value + 5;
