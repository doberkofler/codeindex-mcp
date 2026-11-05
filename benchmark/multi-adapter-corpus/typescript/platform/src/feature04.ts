import {formatRecord} from './format.js';
import {type PlatformRecord} from './model.js';

export const feature04 = (record: PlatformRecord): string => `platform-${formatRecord(record)}`;

export const feature04Value = (record: PlatformRecord): number => record.value + 4;
