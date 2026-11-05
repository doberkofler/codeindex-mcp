import {formatRecord} from './format.js';
import {type PlatformRecord} from './model.js';

export const feature01 = (record: PlatformRecord): string => `platform-${formatRecord(record)}`;

export const feature01Value = (record: PlatformRecord): number => record.value + 1;
