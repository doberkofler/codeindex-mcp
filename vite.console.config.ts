import path from 'node:path';
import {defineConfig} from 'vite';

export default defineConfig({
	root: path.resolve(import.meta.dirname, 'src', 'ui', 'console'),
	base: '/',
	build: {
		outDir: path.resolve(import.meta.dirname, 'dist', 'console'),
		emptyOutDir: true,
		target: 'es2024',
		minify: 'oxc',
		sourcemap: false,
		chunkSizeWarningLimit: 700,
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/},
						{name: 'mui', test: /node_modules[\\/]@mui[\\/]/},
						{name: 'tanstack', test: /node_modules[\\/]@tanstack[\\/]/},
					],
				},
			},
			/*
			 * Ignore "use client" warnings since we are not using SSR.
			 * see https://github.com/TanStack/query/pull/5161#issuecomment-1477389761
			 */
			onLog(level, log, defaultHandler) {
				if (log.code === 'MODULE_LEVEL_DIRECTIVE' && log.message.includes('"use client"')) {
					return;
				}
				defaultHandler(level, log);
			},
		},
	},
});
