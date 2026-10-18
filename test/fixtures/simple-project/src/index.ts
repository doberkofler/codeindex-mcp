import {UserService, defaultUser, formatUser} from '@app/models';
import type {User, UserId} from '@app/models';
import type {SharedContract} from '../shared/contracts.js';

export type {User} from '@app/models';
export {formatUser} from '@app/models';

export const contractId = (contract: SharedContract): string => contract.id;

export const describeUser = (id: UserId): string => {
	const service = new UserService([defaultUser]);
	const user: User | undefined = service.find(id);

	return user === undefined ? service.describe(id) : formatUser(user);
};
