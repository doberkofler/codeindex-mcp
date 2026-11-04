import {serverFS, type FileSystemCallbacks} from 'typescript/fs';
import {type RecorderType} from './snapshotRecorder.ts';

/**
 * Adapts the capture recorder to the compiler host filesystem interface.
 *
 * Every compiler read, existence probe, and directory listing is recorded, so
 * configuration parsing, module resolution, and program construction observe
 * one immutable snapshot and contribute to the captured manifest.
 *
 * @param recorder - Capturing filesystem.
 * @returns Host filesystem callbacks backed by the recorder.
 */
export const recorderFileSystem = (recorder: RecorderType): FileSystemCallbacks => ({
	fileExists: (fileName) => recorder.fileExists(fileName),
	readFile: (fileName) => recorder.readFile(fileName),
	directoryExists: (directoryName) => recorder.directoryExists(directoryName),
	getAccessibleEntries: (directoryName) => {
		const entries = recorder.entriesOf(directoryName);

		return {
			files: [...entries.files],
			directories: [...entries.directories],
			symlinks: entries.symlinks.length === 0 ? undefined : [...entries.symlinks],
		};
	},
	realpath: (fileName) => recorder.realpath(fileName),
	stat: (fileName) => recorder.stat(fileName),
	writeFile: serverFS.noop,
	removeFile: serverFS.noop,
});
