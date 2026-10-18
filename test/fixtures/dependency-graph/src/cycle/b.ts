import {fromA} from './a.js';

export const fromB = (): (() => void) => fromA;
