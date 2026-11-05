import {formatRecord} from './format.js';
import {type PlatformRecord} from './model.js';

export const feature05 = (record: PlatformRecord): string => `platform-${formatRecord(record)}`;

export const feature05Value = (record: PlatformRecord): number => record.value + 5;
