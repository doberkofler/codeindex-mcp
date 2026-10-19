create or replace package body sales_api as
	procedure sync_employee(p_employee_id number) is
		l_employee hr_api.t_employee%type;
		l_name varchar2(100);
	begin
		hr_api.delete_employee(p_employee_id);
		l_name := hr_api.employee_label(l_employee);
		l_name := l_name || hr_api.c_default_salary;
		external_api.audit(p_employee_id);
	end sync_employee;
end sales_api;
/
