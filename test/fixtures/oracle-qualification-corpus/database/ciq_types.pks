create or replace package ciq_types as
	subtype t_name is varchar2(100);

	type t_employee is record (
		employee_id number,
		name t_name,
		salary number
	);

	type t_employees is table of t_employee index by pls_integer;
	type t_codes is varray(5) of number;
	type t_ref is ref cursor return ciq_employee%rowtype;

	c_default_salary constant number := 1000;
	g_last_id number;
	e_invalid exception;

	cursor c_employee_ids is
		select employee_id from ciq_employee order by employee_id;

	function label(p_employee t_employee) return t_name;
	procedure reset;
end ciq_types;
/
