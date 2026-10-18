declare module 'external-package' {
	export function debounce(callback: () => void, delay: number): () => void;
}
