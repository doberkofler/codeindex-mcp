export const measure = (): number => {
	const {left, right} = {left: 1, right: 2};
	return left + right;
};

export const nested = (): number => {
	const {
		outer: {inner},
	} = {outer: {inner: 3}};
	return inner;
};

export const product = (): number => {
	const {first, second} = {first: 4, second: 5};
	return first * second;
};
