import {BaseRecord} from './base';

export class DerivedRecord extends BaseRecord {
	override describe(): string {
		return 'derived';
	}
}

export class DeepRecord extends DerivedRecord {
	override describe(): string {
		return 'deep';
	}
}

export class MoreRecord extends BaseRecord {
	override describe(): string {
		return 'more';
	}
}

export class UltraRecord extends DeepRecord {
	override describe(): string {
		return 'ultra';
	}
}
