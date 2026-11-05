import {type ConfiguredAdapterType, type ProjectContextConfigType} from '@codeindex/adapter-sdk';

export type {ProjectContextConfigType} from '@codeindex/adapter-sdk';

/** One configured adapter and the project contexts it owns. */
export type AdapterConfigType = ConfiguredAdapterType;

export type ConfigType = Readonly<{
	readonly projectName: string;
	readonly rootDir: string;
	/**
	 * Every configured adapter, in declaration order.
	 *
	 * Production resolves this from `extractors` (or the normalised singular
	 * `extractor`). It is optional only so tests and qualification harnesses can
	 * build a singular configuration directly.
	 */
	readonly adapters?: readonly AdapterConfigType[] | undefined;
	/**
	 * Singular projection of the first configured adapter.
	 *
	 * A multi-adapter workspace must resolve adapter identity from `adapters`;
	 * this field exists for singular-only surfaces and legacy fixtures.
	 */
	readonly extractorId: string;
	readonly extractorOptions: Readonly<Record<string, unknown>>;
	/** First configured project; retained for compatibility with single-project surfaces. */
	readonly projectFilePath: string;
	readonly projects: readonly ProjectContextConfigType[];
	/** Root holding one directory per indexed project. */
	readonly storageDirectory: string;
	readonly databasePath: string;
	readonly analyticsEnabled: boolean;
	readonly analyticsPath: string;
	readonly maxResultBytes: number;
	readonly maxReadLines: number;
	readonly semanticDiagnostics: boolean;
	/**
	 * Quiet period after the last filesystem event before a rebuild starts.
	 *
	 * Trailing-edge debounce: every new event restarts the window, so a burst of
	 * editor saves becomes one rebuild. One shared watcher and coordinator serve
	 * every adapter, so this is a workspace-level value, not a per-adapter one.
	 */
	readonly freshnessDebounceMs: number;
	/** Milliseconds an idle build worker is retained between refreshes. */
	readonly buildWorkerIdleMs?: number;
	/** Whole process-tree RSS ceiling; an oversized worker is restarted. */
	readonly buildWorkerMaxRssBytes?: number;
	readonly projectId: string;
	readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
	readonly configPath: string | null;
}>;

/**
 * Returns the configured adapters, defaulting to the singular projection.
 *
 * @param config - Resolved configuration.
 * @returns Every configured adapter.
 */
export const configuredAdapters = (config: ConfigType): readonly AdapterConfigType[] =>
	config.adapters ?? [
		{
			id: config.extractorId,
			required: true,
			options: config.extractorOptions,
			projectFilePath: config.projectFilePath,
			projects: config.projects,
		},
	];

/**
 * Projects a multi-adapter configuration onto one adapter.
 *
 * Adapters receive only their own project contexts and options, so no adapter
 * can observe another adapter's configuration.
 *
 * @param config - Resolved multi-adapter configuration.
 * @param adapter - Adapter to project.
 * @returns A configuration whose singular projection is the selected adapter.
 */
export const adapterConfigFor = (config: ConfigType, adapter: AdapterConfigType): ConfigType => ({
	...config,
	adapters: [adapter],
	extractorId: adapter.id,
	extractorOptions: adapter.options,
	projectFilePath: adapter.projectFilePath,
	projects: adapter.projects,
});
