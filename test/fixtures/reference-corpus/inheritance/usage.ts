import {BaseRecord} from './base';
import {DeepRecord, DerivedRecord, MoreRecord, UltraRecord} from './derived';

new BaseRecord().describe();
void new BaseRecord().id;
new DerivedRecord().describe();
new DeepRecord().describe();
new MoreRecord().describe();
new UltraRecord().describe();
