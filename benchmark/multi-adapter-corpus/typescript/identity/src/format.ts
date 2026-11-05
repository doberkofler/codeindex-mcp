import {type IdentityRecord} from './model.js';

export const formatRecord = (record: IdentityRecord): string => `${record.label}:${String(record.value)}`;
