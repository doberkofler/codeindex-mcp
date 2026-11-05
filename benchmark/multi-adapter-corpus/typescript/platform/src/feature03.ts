import {formatRecord} from './format.js';
import {type PlatformRecord} from './model.js';

export const feature03 = (record: PlatformRecord): string => `platform-${formatRecord(record)}`;

export const feature03Value = (record: PlatformRecord): number => record.value + 3;
