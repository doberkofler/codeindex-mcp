import {type ReportingRecord} from './model.js';

export const formatRecord = (record: ReportingRecord): string => `${record.label}:${String(record.value)}`;
