import {type AnalyticsRecorderType} from '../analytics/recorder.ts';
import {type LoggerType} from '../logging/logger.ts';
import {type ScanResultType} from '../model.ts';

/**
 * Reports one runtime-versus-declared compiler drift pair.
 *
 * The pair is recorded at most once per process even though every reconciliation
 * scan observes it again. A new pair, such as an upgraded runtime or a changed
 * declared version, is reported separately.
 *
 * @param input - Logger, analytics sink, observed pairs, and current scan.
 */
export const recordCompilerDrift = (
	input: Readonly<{
		logger: LoggerType;
		analytics: AnalyticsRecorderType | null;
		observed: Set<string>;
		scan: ScanResultType;
	}>,
): void => {
	if (!input.scan.compilerDrift) {
		return;
	}

	const key = `${input.scan.compilerVersion}\u0000${input.scan.declaredCompilerVersion ?? 'unknown'}`;

	if (input.observed.has(key)) {
		return;
	}

	input.observed.add(key);
	input.logger.warn('compiler_drift', {
		extractorCompiler: input.scan.compilerVersion,
		declaredCompiler: input.scan.declaredCompilerVersion,
	});
	input.analytics?.record('compiler_drift', {
		extractorVersion: input.scan.compilerVersion,
		declaredVersion: input.scan.declaredCompilerVersion,
	});
};
