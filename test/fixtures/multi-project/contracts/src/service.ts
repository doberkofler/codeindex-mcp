export type ServiceRequest = Readonly<{id: string}>;

export const handleRequest = (request: ServiceRequest): string => request.id;
