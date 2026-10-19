import {readFileSync} from 'node:fs';
import {parentPort, workerData} from 'node:worker_threads';

const {bundleUrl, defaultSchema, files} = workerData;
const {parseWithAntlrProfiled} = await import(bundleUrl);
const rows = [];
let peakRssBytes = process.memoryUsage().rss;

for (const file of files) {
	const startedAt = performance.now();
	let diagnostics = 0;
	let profile = null;
	let failed = false;

	try {
		const source = readFileSync(file.absolutePath, 'utf8');
		const parsed = parseWithAntlrProfiled({source, path: file.path, defaultSchema});

		diagnostics = parsed.result.diagnostics.length;
		profile = parsed.profile;
	} catch {
		failed = true;
	}

	rows.push({
		index: file.index,
		path: file.path,
		bytes: file.bytes,
		ms: performance.now() - startedAt,
		diagnostics,
		failed,
		profile,
	});
	peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}

parentPort?.postMessage({peakRssBytes, rows});
