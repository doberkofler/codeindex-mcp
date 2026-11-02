import {debounce} from 'external-package';
import * as externalPackage from 'external-package';

export const directExternal = debounce(() => undefined, 50);
export const directExternalThroughNamespace = externalPackage.debounce(() => undefined, 75);
