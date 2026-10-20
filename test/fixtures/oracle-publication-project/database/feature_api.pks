create or replace package feature_api as
	type t_item is record (
		id number
	);

	cursor c_items return t_item;

	g_item t_item;
	g_note varchar2(10);

	procedure write_item(p_item in out t_item, p_note out varchar2);

	procedure external_proc(p_value number) is language java name 'Feature.run(number)';

	function ptf_rows(p_value number) return table pipelined row polymorphic using ptf_rows_impl;
end feature_api;
/
