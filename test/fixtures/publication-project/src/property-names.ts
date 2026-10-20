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

export const Registry = new class Registry {
	read(): string {
		return 'registry';
	}
};
