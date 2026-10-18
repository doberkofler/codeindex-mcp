import {formatter as defaults} from './oxc.config.ts';

// Project-specific Oxfmt overrides.
const formatter: Partial<typeof defaults> = {};

const config = {...defaults, ...formatter};

export default config;
