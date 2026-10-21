export type PaymentGateway = {
	readonly charge: (amount: number) => string;
};
