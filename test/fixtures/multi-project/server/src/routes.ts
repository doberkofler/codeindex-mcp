import 'shared-package';
import {type ServiceRequest} from '../../contracts/src/service.js';

export const route = (request: ServiceRequest): string => request.id;
