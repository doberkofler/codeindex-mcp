import {debounce} from 'lodash';
import {fromB} from './b.js';

export const fromA = (): (() => void) => {
	fromB();
	return debounce(() => undefined, 5);
};
