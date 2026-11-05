import {formatRecord} from './format.js';
import {type ReportingRecord} from './model.js';

export const feature02 = (record: ReportingRecord): string => `reporting-${formatRecord(record)}`;

export const feature02Value = (record: ReportingRecord): number => record.value + 2;
