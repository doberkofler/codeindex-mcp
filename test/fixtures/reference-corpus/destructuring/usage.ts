export const {left, right} = {left: 1, right: 2};

export const {
	outer: {inner},
} = {outer: {inner: 3}};

export const {first, second} = {first: 4, second: 5};

export const measure = (): number => left + right;

export const nested = (): number => inner;

export const product = (): number => first * second;
