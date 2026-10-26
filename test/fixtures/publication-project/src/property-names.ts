enum PropertyNames {
	First = 'first',
}

export const propertyNames = {
	'server-time': {
		command: 'python',
	},
	[PropertyNames.First]: {
		enabled: true,
	},
};

// An empty string is a valid property key, so the persisted binding name may be
// empty. VS Code declares `{ '': HTMLDivElement }` in the same shape.
export type EmptyKeyedAttributes = {
	'': string;
};

export const Registry = new class Registry {
	read(): string {
		return 'registry';
	}
};
