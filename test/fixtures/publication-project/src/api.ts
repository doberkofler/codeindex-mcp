export interface Point {
	readonly x: number;
	readonly y: number;
}

export class Hidden {
	public m(): void {}
}

class Supporting {
	public s(): void {}
}

export const supported: Supporting = new Supporting();

export const api: {run(): void; nested: {deep(): void}} = {
	run(): void {},
	nested: {deep(): void {}},
};

export const hidden: Hidden = new Hidden();

export async function load(): Promise<{ready: boolean}> {
	return {ready: true};
}

export function list(): {k: string}[] {
	return [];
}

export default function () {
	return {go(): void {}};
}
