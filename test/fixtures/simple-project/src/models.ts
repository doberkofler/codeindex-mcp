export type UserId = string;

export type UserRole = 'admin' | 'member';

export type User = {
	readonly id: UserId;
	readonly name: string;
	readonly role: UserRole;
};

export const defaultUser: User = {id: 'anonymous', name: 'Anonymous', role: 'member'};

export const formatUser = (user: User): string => `${user.name} <${user.id}>`;

export class UserService {
	readonly cache: User[];

	constructor(users: readonly User[]) {
		this.cache = [...users];
	}

	find(id: UserId): User | undefined {
		return this.cache.find((user) => user.id === id);
	}

	describe(id: UserId): string {
		const user = this.find(id);
		return user === undefined ? 'unknown' : formatUser(user);
	}
}

export enum Permission {
	Read = 'read',
	Write = 'write',
}
