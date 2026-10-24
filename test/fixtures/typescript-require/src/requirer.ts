declare const enabled: boolean;

const whole = require('./dep');
const {value, helper: renamed} = require('./dep');

if (enabled) {
	require('optional-package');
}

export {renamed, value, whole};
