import {type AdapterConfigType, type ProjectContextConfigType} from './adapterConfig.ts';
import {DEFAULT_EXTRACTOR_ID, DEFAULT_PROJECT_FILE, assertFile, derivedProjectName, fail, resolveWithin} from './configSupport.ts';

type ExtractorEntryInputType = Readonly<{
	id?: string | undefined;
	required?: boolean | undefined;
	module?: string | undefined;
	project?: string | undefined;
	projects?: readonly Readonly<{name?: string | undefined; project: string}>[] | undefined;
	options?: Readonly<Record<string, unknown>> | undefined;
}>;

type ResolveAdaptersInputType = Readonly<{
	environment: Readonly<{CODE_INDEX_EXTRACTOR?: string | undefined; CODE_INDEX_PROJECT_FILE?: string | undefined}>;
	extractor?: ExtractorEntryInputType | undefined;
	extractors?: readonly ExtractorEntryInputType[] | undefined;
	realRootDir: string;
	cwd: string;
}>;

type ExtractorEntryType = Readonly<{
	id: string;
	required: boolean;
	module?: string | undefined;
	project: string | undefined;
	projects: readonly Readonly<{name: string | undefined; project: string}>[] | undefined;
	options: Readonly<Record<string, unknown>>;
}>;

const projectContextsOfEntry = (entry: ExtractorEntryType, realRootDir: string): readonly ProjectContextConfigType[] => {
	if (entry.project !== undefined && entry.projects !== undefined) {
		return fail(`extractor ${entry.id}: project and projects are mutually exclusive`);
	}

	if (entry.id === 'oracle' && entry.project === undefined && entry.projects === undefined) {
		return fail(`the oracle extractor requires project or projects to name an Oracle manifest`);
	}

	const entries: readonly Readonly<{name: string | undefined; project: string}>[] = entry.projects?.map((project) => ({
		name: project.name,
		project: project.project,
	})) ?? [{name: undefined, project: entry.project ?? DEFAULT_PROJECT_FILE}];
	const contexts = entries.map((context) => {
		const projectFilePath = resolveWithin(realRootDir, realRootDir, context.project, 'project file');

		assertFile(projectFilePath, 'project file');

		return {
			name: context.name ?? derivedProjectName(realRootDir, projectFilePath),
			projectFilePath,
		};
	});
	const names = new Set<string>();
	const paths = new Set<string>();

	for (const context of contexts) {
		if (names.has(context.name)) {
			return fail(`project context name is duplicated for adapter ${entry.id}: ${context.name}`);
		}

		if (paths.has(context.projectFilePath)) {
			return fail(`project file is configured more than once for adapter ${entry.id}: ${context.projectFilePath}`);
		}

		names.add(context.name);
		paths.add(context.projectFilePath);
	}

	return contexts;
};

const entryOfSchema = (entry: ExtractorEntryInputType, fallbackId: string, label: string): ExtractorEntryType => {
	const id = entry.id ?? fallbackId;

	if (entry.id === undefined && label !== 'extractor') {
		return fail(`${label} entries require an explicit id`);
	}

	return {
		id,
		required: entry.required ?? true,
		...(entry.module === undefined ? {} : {module: entry.module}),
		project: entry.project,
		projects: entry.projects?.map((project) => ({name: project.name, project: project.project})),
		options: entry.options ?? {},
	};
};

const resolveAdapter = (
	entry: ExtractorEntryType,
	input: Readonly<{realRootDir: string; cwd: string; singularProjectFile: string | undefined}>,
): AdapterConfigType => {
	const singularContext = (): ProjectContextConfigType => {
		if (input.singularProjectFile === undefined) {
			throw new Error('Expected a singular project file');
		}

		const projectFilePath = resolveWithin(input.realRootDir, input.cwd, input.singularProjectFile, 'project file');
		assertFile(projectFilePath, 'project file');

		return {name: derivedProjectName(input.realRootDir, projectFilePath), projectFilePath};
	};
	const projects = input.singularProjectFile === undefined ? projectContextsOfEntry(entry, input.realRootDir) : [singularContext()];
	const [firstProject] = projects;

	if (firstProject === undefined) {
		return fail(`adapter ${entry.id} requires at least one project`);
	}

	return {
		id: entry.id,
		required: entry.required,
		...(entry.module === undefined ? {} : {module: entry.module}),
		options: entry.options,
		projectFilePath: firstProject.projectFilePath,
		projects,
	};
};

/**
 * Resolves canonical `extractors` or the legacy singular `extractor`.
 *
 * @param input - Environment overrides, file entries, workspace root, and cwd.
 * @returns Every configured adapter in declaration order.
 * @throws {@link Error} When the adapter set is ambiguous or invalid.
 */
export const resolveAdapters = (input: ResolveAdaptersInputType): readonly AdapterConfigType[] => {
	const {environment, extractor, extractors} = input;

	if (extractors !== undefined) {
		if (environment.CODE_INDEX_EXTRACTOR !== undefined) {
			return fail('CODE_INDEX_EXTRACTOR cannot be combined with extractors');
		}

		if (environment.CODE_INDEX_PROJECT_FILE !== undefined) {
			return fail('CODE_INDEX_PROJECT_FILE cannot be combined with extractors');
		}
	}

	const entries: readonly ExtractorEntryType[] =
		extractors === undefined
			? [
					entryOfSchema(
						{
							id: environment.CODE_INDEX_EXTRACTOR ?? extractor?.id ?? DEFAULT_EXTRACTOR_ID,
							module: extractor?.module,
							project: extractor?.project,
							projects: extractor?.projects,
							options: extractor?.options,
						},
						DEFAULT_EXTRACTOR_ID,
						'extractor',
					),
				]
			: extractors.map((entry) => entryOfSchema(entry, '', 'extractors'));
	const seen = new Set<string>();

	return entries.map((entry) => {
		if (seen.has(entry.id)) {
			return fail(`adapter id is configured more than once: ${entry.id}`);
		}

		seen.add(entry.id);

		return resolveAdapter(entry, {
			realRootDir: input.realRootDir,
			cwd: input.cwd,
			singularProjectFile: extractors === undefined ? environment.CODE_INDEX_PROJECT_FILE : undefined,
		});
	});
};
