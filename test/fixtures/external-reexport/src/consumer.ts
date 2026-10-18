import {debounce} from './facade.js';
import * as facade from './facade.js';

export const delayed = debounce(() => undefined, 100);
export const delayedThroughNamespace = facade.debounce(() => undefined, 100);
