import {type PaymentGateway} from './gateway.js';

export class StripeGateway implements PaymentGateway {
	private readonly scheme = 'stripe';

	public readonly charge = (amount: number): string => `${this.scheme}:${amount}`;
}
