import {debounce} from './facade.js';
import {debounce as debounceTwo} from './facadeTwo.js';
import * as facade from './facade.js';

export const delayed = debounce(() => undefined, 100);
export const delayedTwo = debounceTwo(() => undefined, 200);
export const delayedThroughNamespace = facade.debounce(() => undefined, 100);
