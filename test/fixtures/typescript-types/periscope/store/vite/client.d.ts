declare module '*.css' {
	const css: string;
	export default css;
}

interface ImportMeta {
	readonly env: Readonly<Record<string, string | undefined>>;
}
