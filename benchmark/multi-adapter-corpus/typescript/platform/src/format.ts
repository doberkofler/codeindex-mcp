import {type PlatformRecord} from './model.js';

export const formatRecord = (record: PlatformRecord): string => `${record.label}:${String(record.value)}`;
