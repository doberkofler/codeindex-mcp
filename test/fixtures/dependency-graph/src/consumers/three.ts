import {run} from '../adapters/scoped.js';

export const measured = (): void => {
	run({width: 1});
};
