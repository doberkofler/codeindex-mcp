import {formatRecord} from './format.js';
import {type IdentityRecord} from './model.js';

export const feature01 = (record: IdentityRecord): string => `identity-${formatRecord(record)}`;

export const feature01Value = (record: IdentityRecord): number => record.value + 1;
