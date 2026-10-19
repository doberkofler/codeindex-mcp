create or replace package hr_api as
	-- Public employee record.
	type t_employee is record (
		id number,
		name varchar2(100)
	);

	type t_employee_tt is table of t_employee index by pls_integer;
	subtype t_name is varchar2(100);

	c_default_salary constant number := 1000;
	g_last_id number;
	e_invalid exception;

	function employee_label(p_employee t_employee) return varchar2;

	procedure save_employee(
		p_employee_id in out employees.employee_id%type,
		p_name varchar2,
		p_salary number default 0
	);

	procedure delete_employee(p_employee_id number);

	procedure find_employee(p_employee_id number);
	procedure find_employee(p_name varchar2);
end hr_api;
/
