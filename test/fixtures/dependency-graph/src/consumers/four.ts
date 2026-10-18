import {delayed} from './one.js';

export const nested = (): (() => void) => delayed;
