import {type ReadSymbolResultType} from './model.ts';

type ReadSymbolSourceInputType = Readonly<{
	content: string;
	symbolStartLine: number;
	symbolEndLine: number;
	contextLines: number;
	maxReadLines: number;
	maxResultBytes: number;
}>;

export type ReadSymbolSourceType = Readonly<{
	startLine: number;
	endLine: number;
	source: string;
	truncatedReason: ReadSymbolResultType['truncatedReason'];
}>;

export const readSymbolSource = (input: ReadSymbolSourceInputType): ReadSymbolSourceType => {
	const lines = input.content.split('\n');
	const contextLines = Math.max(0, input.contextLines);
	const firstLine = Math.max(1, input.symbolStartLine - contextLines);
	const requestedLastLine = Math.min(lines.length, input.symbolEndLine + contextLines);
	const maximumLastLine = Math.min(requestedLastLine, firstLine + input.maxReadLines - 1);
	let lastLine = maximumLastLine;
	let reason: ReadSymbolResultType['truncatedReason'] = lastLine < requestedLastLine ? 'lines' : null;

	const slice = (): string => lines.slice(firstLine - 1, lastLine).join('\n');
	let source = slice();

	while (Buffer.byteLength(source, 'utf8') > input.maxResultBytes && lastLine > firstLine) {
		lastLine -= 1;
		reason = 'bytes';
		source = slice();
	}

	if (Buffer.byteLength(source, 'utf8') > input.maxResultBytes) {
		reason = 'bytes';
		source = Buffer.from(source, 'utf8').subarray(0, input.maxResultBytes).toString('utf8');
	}

	return {startLine: firstLine, endLine: lastLine, source, truncatedReason: reason};
};
