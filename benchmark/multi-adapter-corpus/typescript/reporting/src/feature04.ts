import {formatRecord} from './format.js';
import {type ReportingRecord} from './model.js';

export const feature04 = (record: ReportingRecord): string => `reporting-${formatRecord(record)}`;

export const feature04Value = (record: ReportingRecord): number => record.value + 4;
