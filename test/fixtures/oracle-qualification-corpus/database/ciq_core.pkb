create or replace package body ciq_core as
	procedure local_helper(p_value number) is
		l_value number := p_value;
	begin
		l_value := l_value + 1;
	end local_helper;

	function choose(p_value number) return number is
		l_value number;
	begin
		local_helper(p_value);
		l_value := ciq_types.c_default_salary;
		return l_value + p_value;
	end choose;

	function choose(p_value varchar2) return varchar2 is
		l_value varchar2(100);
	begin
		l_value := p_value;
		return l_value;
	end choose;

	procedure forward_helper(p_value number) is
	begin
		local_helper(p_value => p_value);
	end forward_helper;

	procedure read_employee(p_id number) is
		l_employee ciq_employee%rowtype;
	begin
		select * into l_employee from ciq_employee where employee_id = p_id;
		l_employee.salary := l_employee.salary + ciq_types.c_default_salary;
		ciq_types.g_last_id := l_employee.employee_id;
		for r_employee in ciq_types.c_employee_ids loop
			null;
		end loop;
	end read_employee;
end ciq_core;
/
