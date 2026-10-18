import {chunk} from 'lodash';

export const narrow = (values: readonly unknown[]): readonly unknown[][] => chunk(values, 2);
