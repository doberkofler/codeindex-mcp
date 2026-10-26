import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {indexRootDirectory} from '../src/core/config/config.ts';
import {replayOracleEvidenceBundle} from '../src/core/qualification/oracle/live/oracleReplay.ts';

type BundleType = Readonly<{
	descriptorPath: string;
	required: boolean;
	/** Expected disposition of the retained run. */
	gatesOk: boolean;
	declarations: Readonly<{truth: number; matched: number}>;
	references: Readonly<{truth: number; matched: number}>;
	dependencies: Readonly<{truth: number; matched: number}>;
}>;

const BUNDLES: readonly BundleType[] = [
	{
		descriptorPath: 'benchmark/oracle-production-20261027/corpus.json',
		required: true,
		gatesOk: true,
		declarations: {truth: 37_170, matched: 37_151},
		references: {truth: 188_287, matched: 187_665},
		dependencies: {truth: 5553, matched: 5553},
	},
];

const DescriptorSchema = z.object({evidence: z.object({externalRoot: z.string().min(1)})});
const ReportSchema = z.object({
	gates: z.object({ok: z.boolean()}),
	declarations: z.object({truth: z.number().int(), matched: z.number().int()}),
	references: z.object({truth: z.number().int(), matched: z.number().int()}),
	dependencies: z.object({truth: z.number().int(), matched: z.number().int()}),
});

const evidenceRootOf = (descriptorPath: string): string => {
	const descriptor = DescriptorSchema.parse(JSON.parse(readFileSync(descriptorPath, 'utf8')));
	const evidenceRoot = process.env['CODEINDEX_EVIDENCE_ROOT'] ?? indexRootDirectory();

	return path.join(evidenceRoot, descriptor.evidence.externalRoot);
};

const availableOf = (bundle: BundleType): boolean => existsSync(path.join(evidenceRootOf(bundle.descriptorPath), 'plan.json'));

const required = process.env['CODE_INDEX_ORACLE_BUNDLE_REQUIRED'] === '1';

describe('Oracle evidence bundle availability', () => {
	it('retains every required bundle when the bundle tier is selected', () => {
		if (!required) {
			return;
		}

		const missing = BUNDLES.filter((bundle) => bundle.required && !availableOf(bundle)).map((bundle) => evidenceRootOf(bundle.descriptorPath));

		expect(missing).toStrictEqual([]);
	});
});

describe.each(BUNDLES)('Oracle evidence bundle replay: $descriptorPath', (bundle) => {
	describe.skipIf(!availableOf(bundle))('retained bundle', () => {
		it('reproduces the committed report from retained truth without a database', async () => {
			const result = await replayOracleEvidenceBundle(
				{HOME: process.env['HOME'] ?? '', PATH: process.env['PATH'] ?? '', CODE_INDEX_LOG_LEVEL: 'error'},
				{descriptorPath: bundle.descriptorPath},
			);

			expect(result.preflight.ok).toBe(true);
			expect(result.expectedPath).not.toBeNull();
			expect(result.diagnostics).toStrictEqual([]);
			expect(result.differences).toStrictEqual([]);
			expect(result.matches).toBe(true);

			const report = ReportSchema.parse(result.report);

			expect(report.gates.ok).toBe(bundle.gatesOk);
			expect(report.declarations).toMatchObject(bundle.declarations);
			expect(report.references).toMatchObject(bundle.references);
			expect(report.dependencies).toMatchObject(bundle.dependencies);
		});
	});
});
