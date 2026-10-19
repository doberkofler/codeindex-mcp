create or replace package body hr_api as
	g_private constant number := 1;

	function employee_label(p_employee t_employee) return varchar2 is
		l_label varchar2(100);
	begin
		l_label := p_employee.name || ' (' || g_private || ')';
		return l_label;
	end employee_label;

	procedure save_employee(
		p_employee_id in out employees.employee_id%type,
		p_name varchar2,
		p_salary number default 0
	) is
	begin
		if p_name is null then
			hr_api.delete_employee(p_employee_id);
		end if;

		g_last_id := p_employee_id;
	end save_employee;

	procedure delete_employee(p_employee_id number) is
	begin
		null;
	end delete_employee;

	procedure find_employee(p_employee_id number) is
	begin
		hr_api.delete_employee(p_employee_id);
	end find_employee;

	procedure find_employee(p_name varchar2) is
		procedure log_lookup is
		begin
			null;
		end log_lookup;
	begin
		log_lookup;
		hr_api.find_employee(p_name => p_name);
	end find_employee;

	procedure forward_helper(p_value number);

	procedure forward_helper(p_value number) is
	begin
		null;
	end forward_helper;

	procedure private_helper(p_value number) is
	begin
		hr_api.delete_employee(p_value);
	end private_helper;
begin
	g_last_id := 0;
end hr_api;
/
