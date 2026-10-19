declare module 'lodash' {
	export function debounce(callback: () => void, delay: number): () => void;
}
