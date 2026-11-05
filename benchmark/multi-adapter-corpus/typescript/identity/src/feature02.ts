import {formatRecord} from './format.js';
import {type IdentityRecord} from './model.js';

export const feature02 = (record: IdentityRecord): string => `identity-${formatRecord(record)}`;

export const feature02Value = (record: IdentityRecord): number => record.value + 2;
