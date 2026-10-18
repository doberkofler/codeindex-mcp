import {type EdgeProps} from './edges';

export const EdgePanel = (props: EdgeProps) => (
	<section data-tone={props.tone}>
		<span>{props.title}</span>
	</section>
);
