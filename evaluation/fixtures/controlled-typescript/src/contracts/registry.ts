import {type PaymentGateway} from './gateway.js';

export type GatewayFactory = (gateway: PaymentGateway) => PaymentGateway;
