import {type PaymentGateway} from './gateway.js';

export class InvoiceGateway implements PaymentGateway {
	private readonly scheme = 'invoice';

	public readonly charge = (amount: number): string => `${this.scheme}:${amount}`;
}
