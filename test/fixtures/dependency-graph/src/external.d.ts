declare module 'lodash' {
	export function debounce(callback: () => void, delay: number): () => void;
}

declare module 'lodash/escape.js' {
	export default function escape(value: string): string;
}

declare module '@scope/pkg' {
	export type Shape = Readonly<{width: number}>;
	export default function measure(shape: Shape): void;
}
