import {formatRecord} from './format.js';
import {type IdentityRecord} from './model.js';

export const feature03 = (record: IdentityRecord): string => `identity-${formatRecord(record)}`;

export const feature03Value = (record: IdentityRecord): number => record.value + 3;
