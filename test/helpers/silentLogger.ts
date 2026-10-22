import {type LoggerType} from '../../src/core/logging/logger.ts';

const silence = (): void => {
	void 0;
};

export const silentLogger: LoggerType = {
	debug: silence,
	info: silence,
	warn: silence,
	error: silence,
};
