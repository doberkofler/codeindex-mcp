/** Maintainer-only adapter internals used by host qualification tooling. */

export {loadTypeScriptProject, type LoadedProjectType} from './loadProject.ts';
export {scanProject} from './scanProject.ts';
export {buildTypeScriptFacts, typeScriptExtractor} from './index.ts';
export {disposeTypeScriptSessions, typeScriptWarmSessionMetrics, type TypeScriptWarmSessionMetricsType} from './inputSnapshot.ts';
