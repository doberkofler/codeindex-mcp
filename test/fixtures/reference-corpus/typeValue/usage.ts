import type {OnlyType} from './model';
import {MixedEnum, MixedModel} from './model';

void (null as unknown as OnlyType);
void (null as unknown as MixedModel);
new MixedModel();
void new MixedModel().kind;
void (null as unknown as MixedEnum);
void MixedEnum.First;
void MixedEnum.Second;
