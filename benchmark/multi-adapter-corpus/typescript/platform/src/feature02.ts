import {formatRecord} from './format.js';
import {type PlatformRecord} from './model.js';

export const feature02 = (record: PlatformRecord): string => `platform-${formatRecord(record)}`;

export const feature02Value = (record: PlatformRecord): number => record.value + 2;
