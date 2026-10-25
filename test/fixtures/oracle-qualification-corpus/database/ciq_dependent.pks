create or replace package ciq_dependent as
	function describe_employee(p_id number) return varchar2;
end ciq_dependent;
/
