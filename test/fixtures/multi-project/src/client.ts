import 'shared-package';
import {handleRequest, type ServiceRequest} from '@contracts/service';

export const client = (request: ServiceRequest): string => handleRequest(request);
