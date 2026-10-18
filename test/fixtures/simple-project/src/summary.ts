import {describeUser} from './index';

export const summary = (ids: readonly string[]): string => ids.map((id) => describeUser(id)).join(', ');
