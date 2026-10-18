export type PanelProps = {
	readonly title: string;
	readonly tone: string;
};

export const Panel = (props: PanelProps) => (
	<section data-tone={props.tone}>
		<h1>{props.title}</h1>
	</section>
);

export const Badge = (props: PanelProps) => <span data-tone={props.tone}>{props.title}</span>;

export const Chip = (props: PanelProps) => <strong data-tone={props.tone}>{props.title}</strong>;
