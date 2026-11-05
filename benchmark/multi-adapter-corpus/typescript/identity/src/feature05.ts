import {formatRecord} from './format.js';
import {type IdentityRecord} from './model.js';

export const feature05 = (record: IdentityRecord): string => `identity-${formatRecord(record)}`;

export const feature05Value = (record: IdentityRecord): number => record.value + 5;
