create or replace package ciq_core as
	function choose(p_value number) return number;
	function choose(p_value varchar2) return varchar2;
	procedure forward_helper(p_value number);
	procedure read_employee(p_id number);
end ciq_core;
/
