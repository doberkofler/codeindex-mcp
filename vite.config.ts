import path from 'node:path';
import {defineConfig} from 'vitest/config';
import packageManifest from './package.json' with {type: 'json'};

const ENTRY_NAMES = ['mcp', 'cli', 'console'] as const;
type EntryNameType = (typeof ENTRY_NAMES)[number];

const isEntryName = (value: string): value is EntryNameType => ENTRY_NAMES.some((name) => name === value);

const requireEntryName = (value: string): EntryNameType => {
	if (isEntryName(value)) {
		return value;
	}

	throw new Error(`Unsupported CODE_INDEX_ENTRY: ${value}`);
};

const entryName = requireEntryName(process.env['CODE_INDEX_ENTRY'] ?? 'mcp');

export default defineConfig({
	define: {
		PROGRAM_VERSION_AT_BUILD: JSON.stringify(packageManifest.version),
	},
	build: {
		ssr: true,
		lib: {
			entry: path.resolve(import.meta.dirname, 'src', 'entries', `${entryName}.ts`),
			formats: ['es'],
			fileName: () => entryName,
		},
		rolldownOptions: {
			output: {
				entryFileNames: `${entryName}.mjs`,
			},
		},
		outDir: 'dist',
		emptyOutDir: entryName === 'mcp',
		target: 'node26',
		minify: 'oxc',
		sourcemap: false,
		copyPublicDir: false,
	},
});
