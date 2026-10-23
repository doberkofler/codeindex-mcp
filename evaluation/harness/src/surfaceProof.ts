import path from 'node:path';
import {assertMcpReady, probeMcpReadiness, type McpReadinessType} from './mcpReadiness.ts';
import {OpenCodeServerError} from './opencodeServer.ts';
import {SurfaceReadinessError} from './requestSurface.ts';
import {writeJsonAtomic} from './result.ts';
import {nativeCatalogToolsOf} from './surface.ts';
import {capturePresentedTools, type CapturedSurfaceType} from './surfaceProbe.ts';
import {type ToolSurfaceType, type TreatmentDefinitionType} from './treatment.ts';
import {treatmentConfigOf, type WorkspaceContextType} from './workspace.ts';

/** One treatment's readiness and cold-start proof inputs. */
export type TreatmentProofInputType = Readonly<{
	runDir: string;
	coldStarts: number;
	context: WorkspaceContextType;
	treatment: TreatmentDefinitionType;
	surface: ToolSurfaceType;
}>;

/** Completed proof: artifact readiness plus the last exact cold start. */
export type TreatmentProofType = Readonly<{
	readiness: McpReadinessType | null;
	captured: CapturedSurfaceType;
}>;

const evidenceDirectoryOf = (input: TreatmentProofInputType): string => path.join(input.runDir, 'surface', input.treatment.id);

const readinessOf = async (input: TreatmentProofInputType): Promise<McpReadinessType | null> => {
	if (input.treatment.kind === 'no-index') {
		return null;
	}

	if (input.treatment.mcp === null) {
		throw new Error(`${input.treatment.id} declares a CodeIndex treatment without an MCP server`);
	}

	const {config} = treatmentConfigOf(input.context, input.treatment, input.surface);
	const server = config.mcp.servers[input.treatment.mcp.server];

	if (server === undefined) {
		throw new Error(`${input.treatment.id} configuration does not declare the ${input.treatment.mcp.server} MCP server`);
	}

	// A configured server, a spawned process, or registration activity is not
	// readiness. The exact configured command must complete an MCP handshake and
	// return the declared native catalog before any agent prompt is admitted.
	const record = await probeMcpReadiness({
		command: server.command,
		cwd: input.context.workspacePath(input.treatment.id),
		expectedTools: nativeCatalogToolsOf(input.surface, input.treatment.mcp.server),
	});

	writeJsonAtomic(path.join(evidenceDirectoryOf(input), 'readiness.json'), record, true);

	return assertMcpReady(record);
};

const coldStartEvidenceOf = (input: TreatmentProofInputType, captured: CapturedSurfaceType, coldStart: number): unknown => ({
	recordType: 'surface-cold-start',
	treatmentId: input.treatment.id,
	coldStart,
	coldStarts: input.coldStarts,
	openCodeReadiness: captured.serverReadiness,
	request: captured.ledger,
});

const failureEvidenceOf = (input: TreatmentProofInputType, error: unknown, coldStart: number): Readonly<{record: unknown; cause: string; detail: string}> => {
	const readinessError = error instanceof OpenCodeServerError ? error : null;
	const surfaceError = error instanceof SurfaceReadinessError ? error : null;
	const cause = readinessError === null ? (surfaceError?.cause ?? 'probe-failed') : 'mcp-not-ready';
	const detail = error instanceof Error ? error.message : String(error);

	return {
		cause,
		detail,
		record: {
			recordType: 'surface-proof-failure',
			treatmentId: input.treatment.id,
			coldStart,
			coldStarts: input.coldStarts,
			cause,
			...(readinessError === null ? {} : {serverCause: readinessError.cause, openCodeReadiness: readinessError.readiness}),
			detail,
			request: surfaceError?.ledger ?? null,
		},
	};
};

const coldStartsOf = async (input: TreatmentProofInputType, workspace: string): Promise<CapturedSurfaceType> => {
	const directory = evidenceDirectoryOf(input);
	let last: CapturedSurfaceType | null = null;

	for (let coldStart = 1; coldStart <= input.coldStarts; coldStart += 1) {
		const file = path.join(directory, `cold-start-${String(coldStart).padStart(2, '0')}.json`);

		try {
			const captured = await capturePresentedTools({
				workspace,
				surface: input.surface,
				...(input.treatment.mcp === null ? {} : {mcpServer: input.treatment.mcp.server}),
			});

			writeJsonAtomic(file, coldStartEvidenceOf(input, captured, coldStart), true);
			last = captured;
		} catch (error) {
			const failure = failureEvidenceOf(input, error, coldStart);

			writeJsonAtomic(file, failure.record, true);

			throw new Error(
				`${input.treatment.id} cold start ${coldStart}/${input.coldStarts} did not expose the declared agent request-1 surface (${failure.cause}): ${failure.detail}`,
				{cause: error},
			);
		}
	}

	if (last === null) {
		throw new Error(`${input.treatment.id} produced no request-1 cold-start evidence`);
	}

	return last;
};

/**
 * Requires actual MCP readiness and an exact agent request-1 surface for one
 * treatment.
 *
 * Evidence is written before the caller proceeds, so a failed proof retains its
 * closed cause even though the campaign stops before any hosted-model request.
 *
 * @param input - Run directory, cold-start count, workspace context, treatment, and surface.
 * @returns The artifact readiness record and the last passing cold start.
 */
export const prepareTreatmentProofOf = async (input: TreatmentProofInputType): Promise<TreatmentProofType> => {
	const readiness = await readinessOf(input);
	const workspace = input.context.workspacePath(input.treatment.id);
	const captured = await coldStartsOf(input, workspace);

	return {readiness, captured};
};
