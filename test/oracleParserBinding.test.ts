import {describe, expect, it} from 'vitest';
import {buildGeneration} from '../src/core/generation/buildGeneration.ts';
import {IndexDatabase} from '../src/core/storage/database.ts';
import {buildOracleFacts, createOracleExtractor, scanOracleFacts} from '../src/adapters/oracle/index.ts';
import {scanOracleProject} from '../src/adapters/oracle/scanProject.ts';
import {configForOracleParser, oracleParserIdOfConfig} from '../src/adapters/oracle/parserBinding.ts';
import {oracleParserIdentityOf, parseOracleParserId} from '../src/adapters/oracle/parserIdentity.ts';
import {structuralOracleParser} from '../src/adapters/oracle/parseUnits.ts';
import {type OracleParseInputType, type OracleParseResultType} from '../src/adapters/oracle/syntax.ts';
import {adapterSetOf} from './helpers/adapters.ts';
import {createFixtureConfig, silentLogger} from './helpers/fixture.ts';

const projects = [{name: 'app', project: 'oracle-index.json'}];

describe('Oracle parser selection', () => {
	it('defaults to the structural parser', () => {
		const fixture = createFixtureConfig('oracle-project', projects, 'oracle');

		try {
			expect(oracleParserIdOfConfig(fixture.config)).toBe('structural');
		} finally {
			fixture.cleanup();
		}
	});

	it('pins and validates parser identifiers', () => {
		const fixture = createFixtureConfig('oracle-project', projects, 'oracle');

		try {
			const antlrConfig = configForOracleParser(fixture.config, 'antlr');

			expect(oracleParserIdOfConfig(antlrConfig)).toBe('antlr');
			expect(parseOracleParserId('structural')).toBe('structural');
			expect(() => parseOracleParserId('other')).toThrow(/Unknown Oracle parser/u);
			expect(() => oracleParserIdOfConfig({...fixture.config, extractorOptions: {oracleParser: 1}})).toThrow(/must be a string/u);
		} finally {
			fixture.cleanup();
		}
	});

	it('changes compilerVersion and configHash across parsers', () => {
		const fixture = createFixtureConfig('oracle-project', projects, 'oracle');

		try {
			const structural = scanOracleProject(fixture.config, []);
			const antlr = scanOracleProject(configForOracleParser(fixture.config, 'antlr'), []);

			expect(structural.compilerVersion).toContain('parser@structural');
			expect(antlr.compilerVersion).toContain('parser@antlr');
			expect(structural.compilerVersion).not.toBe(antlr.compilerVersion);
			expect(structural.configHash).not.toBe(antlr.configHash);
			expect(structural.sourceHash).toBe(antlr.sourceHash);
		} finally {
			fixture.cleanup();
		}
	});

	it('rejects a configuration that selects another parser implementation', () => {
		const fixture = createFixtureConfig('oracle-project', projects, 'oracle');

		try {
			const antlrConfig = configForOracleParser(fixture.config, 'antlr');

			expect(() => scanOracleFacts(antlrConfig, [])).toThrow(/bound to structural/u);
			expect(() => buildOracleFacts(antlrConfig, scanOracleProject(antlrConfig, []))).toThrow(/bound to structural/u);
		} finally {
			fixture.cleanup();
		}
	});

	it('injects the bound parser into extraction', async () => {
		const fixture = createFixtureConfig('oracle-project', projects, 'oracle');
		const parsedPaths: string[] = [];
		const binding = {
			identity: oracleParserIdentityOf('structural'),
			parser: (input: OracleParseInputType): OracleParseResultType => {
				parsedPaths.push(input.path);
				return structuralOracleParser(input);
			},
		};
		const extractor = createOracleExtractor(binding);
		const database = IndexDatabase.open(fixture.config.databasePath, {
			rootDir: fixture.config.rootDir,
			projectFilePath: fixture.config.projectFilePath,
			projectId: fixture.config.projectId,
			extractorId: fixture.config.extractorId,
		});

		try {
			const scan = scanOracleProject(fixture.config, []);
			const report = await buildGeneration({
				config: fixture.config,
				database,
				logger: silentLogger,
				scan,
				force: true,
				extractor,
				adapters: adapterSetOf(extractor),
			});

			expect(parsedPaths.sort()).toStrictEqual(scan.files.map((file) => file.path).sort());
			expect(report.symbolCount).toBeGreaterThan(0);
			expect(report.reused).toBe(false);

			const antlrScan = scanOracleProject(configForOracleParser(fixture.config, 'antlr'), []);
			const structuralReuse = database.findReusableGeneration(scan.sourceHash, scan.configHash);
			const antlrReuse = database.findReusableGeneration(antlrScan.sourceHash, antlrScan.configHash);

			expect(structuralReuse?.id).toBe(report.generationId);
			expect(antlrReuse).toBeNull();
		} finally {
			database.close();
			fixture.cleanup();
		}
	});
});
