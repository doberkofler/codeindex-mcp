create or replace package body feature_api as
	cursor c_items return t_item is
		select id
		from   feature_items;

	procedure helper(p_value number);

	procedure helper(p_value number) is
	begin
		null;
	end helper;

	procedure write_item(p_item in out t_item, p_note out varchar2) is
	begin
		p_note := 'saved';
		p_item.id := p_item.id + 1;
		helper(p_item.id);
	end write_item;
end feature_api;
/
