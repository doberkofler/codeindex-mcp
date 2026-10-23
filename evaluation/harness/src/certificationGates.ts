import {readFileSync} from 'node:fs';
import path from 'node:path';
import {artifactEntriesOf} from './artifact.ts';
import {type CertificationBlockType, type CertificationDesignType} from './certificationDesign.ts';
import {type CertificationGateType, type CertificationRouteEvidenceType} from './certificationAnalysis.ts';
import {evaluationRoot, evaluationStateRoot, settingsOf} from './cliSupport.ts';
import {EVALUATION_CONTRACT, EVALUATION_CONTRACT_PIN, TARIFF_SNAPSHOT} from './economicContract.ts';
import {hashOf} from './hash.ts';
import {type HostedReferenceType} from './hostedReference.ts';
import {writeJsonAtomic} from './result.ts';
import {routeCommand} from './cliRoute.ts';
import {type SuiteType} from './schema.ts';
import {subjectIdentityOf} from './workspace.ts';

/** One loaded certification block with its frozen suite. */
export type CertificationLoadedBlockType = Readonly<{
	block: CertificationBlockType;
	suite: SuiteType;
}>;

/**
 * Reads one JSON file.
 *
 * @param file - Absolute path.
 * @returns Parsed JSON value.
 */
export const readJson = (file: string): unknown => {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as unknown;
	} catch (error) {
		throw new Error(`unable to read certification evidence at ${file}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const recordOf = (value: unknown, field: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw new TypeError(`certification evidence field "${field}" must be an object`);
	}

	return value;
};

const stringOf = (value: unknown, field: string): string => {
	if (typeof value !== 'string') {
		throw new TypeError(`certification evidence field "${field}" must be a string`);
	}

	return value;
};

const arrayOf = (value: unknown, field: string): readonly unknown[] => {
	if (!Array.isArray(value)) {
		throw new TypeError(`certification evidence field "${field}" must be an array`);
	}

	return value;
};

const artifactDigestOf = (root: string): string => hashOf(artifactEntriesOf(root).map((entry) => ({path: entry.path, digest: entry.digest})));

/**
 * Verifies the development-pilot decision and exposure record that authorized
 * this campaign. The records are hash-pinned by the frozen design.
 *
 * @param design - Frozen certification design.
 * @returns Closed authorization gates.
 */
export const authorizationGatesOf = (design: CertificationDesignType): readonly CertificationGateType[] => {
	const gates: CertificationGateType[] = [];
	const reportFile = path.resolve(evaluationRoot, design.authorization.pilot.report);
	const report = readJson(reportFile);
	const reportDigest = hashOf(report);

	if (reportDigest !== design.authorization.pilot.reportDigest) {
		gates.push({
			id: 'authorization-pilot',
			passed: false,
			detail: `development-pilot report digest ${reportDigest} does not match the frozen ${design.authorization.pilot.reportDigest}`,
		});
	} else {
		const record = recordOf(report, 'pilot report');
		const reportDesign = recordOf(record['design'], 'pilot report design');
		const decision = recordOf(record['decision'], 'pilot report decision');
		const passed =
			record['recordType'] === 'development-pilot-report' &&
			record['claimClass'] === 'development-pilot' &&
			record['releaseAuthority'] === false &&
			reportDesign['id'] === design.authorization.pilot.id &&
			reportDesign['digest'] === design.authorization.pilot.digest &&
			decision['decision'] === 'narrow-scope';

		gates.push({
			id: 'authorization-pilot',
			passed,
			detail: passed
				? `development pilot ${design.authorization.pilot.id} authorized the narrow impact-class scope`
				: 'development-pilot evidence does not authorize the frozen impact-class certification',
		});
	}

	const exposureFile = path.resolve(evaluationRoot, design.authorization.exposure.record);
	const exposureDigest = hashOf(readFileSync(exposureFile, 'utf8'));

	gates.push({
		id: 'authorization-exposure',
		passed: exposureDigest === design.authorization.exposure.recordDigest,
		detail:
			exposureDigest === design.authorization.exposure.recordDigest
				? 'direct native MCP was selected explicitly before certification'
				: `exposure record digest ${exposureDigest} does not match the frozen ${design.authorization.exposure.recordDigest}`,
	});

	return gates;
};

/**
 * Verifies the exact staged accepted and candidate artifact trees.
 *
 * @param design - Frozen certification design.
 * @param blocks - Loaded blocks that declare the artifact roots.
 * @returns One closed artifact gate.
 */
export const artifactGateOf = (design: CertificationDesignType, blocks: readonly CertificationLoadedBlockType[]): CertificationGateType => {
	const treatments = blocks.flatMap(({suite}) => suite.treatments);
	const accepted = treatments.find((treatment) => treatment.id === 'accepted');
	const candidate = treatments.find((treatment) => treatment.id === 'candidate');

	if (accepted?.artifact === null || accepted?.artifact === undefined || candidate?.artifact === null || candidate?.artifact === undefined) {
		return {id: 'artifacts', passed: false, detail: 'the frozen suites must declare accepted and candidate artifacts'};
	}

	const observed = [
		{expected: design.artifacts.accepted, declared: accepted.artifact.id, root: path.resolve(evaluationRoot, accepted.artifact.root)},
		{expected: design.artifacts.candidate, declared: candidate.artifact.id, root: path.resolve(evaluationRoot, candidate.artifact.root)},
	].map((artifact) => ({...artifact, observed: artifactDigestOf(artifact.root)}));
	const mismatched = observed.filter((artifact) => artifact.declared !== artifact.expected.id || artifact.observed !== artifact.expected.digest);

	return {
		id: 'artifacts',
		passed: mismatched.length === 0,
		detail:
			mismatched.length === 0
				? `accepted ${design.artifacts.accepted.digest} and candidate ${design.artifacts.candidate.digest} match the staged trees`
				: `staged artifact digest mismatch: ${mismatched.map((artifact) => `${artifact.declared}=${artifact.observed}`).join(', ')}`,
	};
};

/**
 * Verifies the subject revision and content manifest.
 *
 * @param design - Frozen certification design.
 * @returns One closed subject gate.
 */
export const subjectGateOf = (design: CertificationDesignType): CertificationGateType => {
	const subject = subjectIdentityOf(settingsOf().subjectRepo, design.subject.revision);
	const passed = subject.revision === design.subject.revision && subject.contentManifestHash === design.subject.contentManifestHash;

	return {
		id: 'subject',
		passed,
		detail: passed
			? `subject ${design.subject.revision} content manifest ${design.subject.contentManifestHash}`
			: `subject ${String(subject.revision)} content manifest ${subject.contentManifestHash} does not match the frozen design`,
	};
};

/**
 * Verifies the hosted model, runtime, and generation settings.
 *
 * @param design - Frozen certification design.
 * @param hosted - Loaded hosted reference.
 * @returns One closed model gate.
 */
export const modelGateOf = (design: CertificationDesignType, hosted: HostedReferenceType): CertificationGateType => {
	const passed =
		hosted.reference === design.model.reference &&
		hosted.runtime.opencode === design.model.runtime &&
		hashOf(hosted.generation) === hashOf(design.model.generation);

	return {
		id: 'model-identity',
		passed,
		detail: passed
			? `${design.model.reference} on OpenCode ${design.model.runtime} with the pinned generation settings`
			: 'hosted reference model, runtime, or generation settings differ from the frozen design',
	};
};

/**
 * Verifies the frozen tariff snapshot.
 *
 * @param design - Frozen certification design.
 * @returns One closed tariff gate.
 */
export const tariffGateOf = (design: CertificationDesignType): CertificationGateType => {
	const passed =
		hashOf(TARIFF_SNAPSHOT) === design.tariff.digest &&
		TARIFF_SNAPSHOT.id === design.tariff.id &&
		TARIFF_SNAPSHOT.retrievedAt === design.tariff.retrievedAt &&
		TARIFF_SNAPSHOT.source === design.tariff.source;

	return {
		id: 'tariff',
		passed,
		detail: passed ? `tariff ${design.tariff.id} at ${design.tariff.retrievedAt}` : 'tariff snapshot does not match the frozen design',
	};
};

/**
 * Verifies the accepted economic contract.
 *
 * @param design - Frozen certification design.
 * @returns One closed contract gate.
 */
export const contractGateOf = (design: CertificationDesignType): CertificationGateType => {
	const passed =
		design.contract.digest === EVALUATION_CONTRACT_PIN.digest &&
		design.contract.id === EVALUATION_CONTRACT.id &&
		design.contract.version === EVALUATION_CONTRACT.version;

	return {
		id: 'contract',
		passed,
		detail: passed ? `${design.contract.id}@${design.contract.version}` : 'certification design is not bound to the accepted contract',
	};
};

/**
 * Composes the zero-spend gates that must pass before the route gate or any
 * hosted request.
 *
 * @param design - Frozen certification design.
 * @param blocks - Loaded blocks.
 * @param hosted - Loaded hosted reference.
 * @returns Closed zero-spend gates.
 */
export const preflightGatesOf = (
	design: CertificationDesignType,
	blocks: readonly CertificationLoadedBlockType[],
	hosted: HostedReferenceType,
): readonly CertificationGateType[] => [
	{id: 'frozen-design', passed: true, detail: `${design.id} ${design.digest}`},
	contractGateOf(design),
	...authorizationGatesOf(design),
	artifactGateOf(design, blocks),
	subjectGateOf(design),
	modelGateOf(design, hosted),
	tariffGateOf(design),
];

/**
 * Validates a model-free route report against the frozen route pin and
 * artifact identities.
 *
 * @param value - Parsed route report.
 * @returns Sanitized route evidence.
 */
export const routeEvidenceOf = (value: unknown): CertificationRouteEvidenceType => {
	const record = recordOf(value, 'route report');

	if (record['recordType'] !== 'route-report') {
		throw new Error('model-free route evidence must be a route-report');
	}

	const suite = recordOf(record['suite'], 'route report suite');
	const plan = recordOf(record['plan'], 'route report plan');
	const artifacts = recordOf(record['artifacts'], 'route report artifacts');
	const contract = recordOf(record['contract'], 'route report contract');
	const gates = arrayOf(record['gates'], 'route report gates').map((gate, index) => {
		const item = recordOf(gate, `route report gate ${index}`);

		return {
			id: stringOf(item['id'], `gates[${index}].id`),
			result: stringOf(item['result'], `gates[${index}].result`),
			detail: stringOf(item['detail'], `gates[${index}].detail`),
		};
	});
	const probeCount = (name: 'accepted' | 'candidate'): number => {
		const probes = contract[name];

		return Array.isArray(probes) ? probes.length : 0;
	};
	const artifactOf = (name: 'accepted' | 'candidate'): Readonly<{id: string; digest: string}> | null => {
		const artifact = artifacts[name];

		if (artifact === null || artifact === undefined) {
			return null;
		}

		const item = recordOf(artifact, `route report artifacts.${name}`);

		return {id: stringOf(item['id'], `artifacts.${name}.id`), digest: stringOf(item['digest'], `artifacts.${name}.digest`)};
	};

	return {
		reportDigest: hashOf(value),
		generatedAt: stringOf(record['generatedAt'], 'generatedAt'),
		suite: {
			id: stringOf(suite['id'], 'suite.id'),
			version: Number(suite['version']),
			hash: stringOf(suite['hash'], 'suite.hash'),
			revision: stringOf(suite['revision'], 'suite.revision'),
		},
		plan: {id: stringOf(plan['id'], 'plan.id'), hash: stringOf(plan['hash'], 'plan.hash')},
		artifacts: {accepted: artifactOf('accepted'), candidate: artifactOf('candidate')},
		gates,
		presentedGates: gates.filter((gate) => gate.result === 'pass').length,
		contractProbes: {accepted: probeCount('accepted'), candidate: probeCount('candidate')},
		passed: record['passed'] === true,
	};
};

/**
 * Re-runs the model-free complete route and contract probes for the exact
 * staged artifacts, then reads the fresh report.
 *
 * Each artifact runs in its own process. Running the two CodeIndex artifacts
 * concurrently lets their builders contend for CPU and file leases, which can
 * publish a partial generation before the contract probes read it. The frozen
 * gate requires the same plan, cases, expected answers, and probes for each
 * artifact; executing them sequentially preserves that requirement without
 * introducing cross-artifact build interference.
 *
 * @param design - Frozen certification design.
 * @param block - Primary block whose suite and plan are pinned by the design.
 * @returns Sanitized route evidence for both exact artifacts.
 */
export const runRouteGateOf = async (design: CertificationDesignType, block: CertificationBlockType): Promise<CertificationRouteEvidenceType> => {
	const output = path.join('results', 'certification', `${design.id}-${design.digest.slice(0, 16)}`, 'route');
	const runOne = async (treatment: 'accepted' | 'candidate'): Promise<CertificationRouteEvidenceType> => {
		const directory = path.join(output, treatment);
		const flags = new Map<string, string[]>([
			['suite', [block.suite.path]],
			['plan', [design.route.plan]],
			['treatment', [treatment]],
			['output', [directory]],
		]);

		process.stderr.write(`certification route gate ${design.route.plan} ${treatment} for ${block.suite.id}@${block.suite.version}\n`);
		await routeCommand(flags);

		return routeEvidenceOf(readJson(path.join(evaluationStateRoot, directory, 'report.json')));
	};
	const accepted = await runOne('accepted');
	const candidate = await runOne('candidate');
	const passed = accepted.passed && candidate.passed;

	return {
		...accepted,
		reportDigest: hashOf({accepted, candidate}),
		generatedAt: candidate.generatedAt,
		artifacts: {accepted: accepted.artifacts.accepted, candidate: candidate.artifacts.candidate},
		presentedGates: Math.min(accepted.presentedGates, candidate.presentedGates),
		contractProbes: {accepted: accepted.contractProbes.accepted, candidate: candidate.contractProbes.candidate},
		passed,
	};
};

/**
 * Verifies that the campaign manifest and corpus preflight reproduce the frozen
 * design for one executed block.
 *
 * @param design - Frozen certification design.
 * @param block - Executed block.
 * @param run - Run directory holding the campaign manifest and preflight.
 * @param planHash - Digest of the randomized plan.
 * @returns One closed manifest gate.
 */
export const manifestGateOf = (
	design: CertificationDesignType,
	block: CertificationBlockType,
	run: Readonly<{runDir: string}>,
	planHash: string,
): CertificationGateType => {
	const record = recordOf(readJson(path.join(run.runDir, 'manifest.json')), 'campaign manifest');
	const suite = recordOf(record['suite'], 'manifest suite');
	const artifacts = recordOf(record['artifacts'], 'manifest artifacts');
	const candidate = recordOf(artifacts['candidate'], 'manifest artifacts.candidate');
	const subject = recordOf(record['subject'], 'manifest subject');
	const contract = recordOf(record['contract'], 'manifest contract');
	const hosted = recordOf(record['hostedReference'], 'manifest hostedReference');
	const plan = recordOf(record['plan'], 'manifest plan');
	const preflight = recordOf(readJson(path.join(run.runDir, 'preflight.json')), 'preflight');
	const passed =
		record['claimClass'] === 'hosted-model-scoped' &&
		suite['id'] === block.suite.id &&
		suite['version'] === block.suite.version &&
		suite['hash'] === block.suite.hash &&
		contract['digest'] === design.contract.digest &&
		hosted['reference'] === design.model.reference &&
		subject['revision'] === design.subject.revision &&
		subject['contentManifestHash'] === design.subject.contentManifestHash &&
		candidate['digest'] === design.artifacts.candidate.digest &&
		plan['slotCount'] === block.cases.length * block.repetitions * 2 &&
		record['planHash'] === planHash &&
		preflight['result'] === 'pass';

	return {
		id: `${block.id}-manifest`,
		passed,
		detail: passed
			? `campaign ${String(record['campaignId'])} reproduces the frozen suite, candidate artifact, subject, contract, model, plan, and passing corpus preflight`
			: `campaign manifest for ${block.id} differs from the frozen design or corpus preflight did not pass`,
	};
};

/**
 * Writes one sanitized certification record.
 *
 * @param directory - External result directory.
 * @param report - Complete certification record.
 */
export const writeCertificationRecordOf = (directory: string, report: unknown): void => {
	writeJsonAtomic(path.join(directory, 'certification.json'), report, true);
};
