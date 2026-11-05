import {formatRecord} from './format.js';
import {type IdentityRecord} from './model.js';

export const feature04 = (record: IdentityRecord): string => `identity-${formatRecord(record)}`;

export const feature04Value = (record: IdentityRecord): number => record.value + 4;
