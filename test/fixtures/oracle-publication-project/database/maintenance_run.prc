create or replace procedure maintenance_run(p_days number) is
	l_employee hr_api.t_employee%type;
	l_name varchar2(100);
begin
	l_employee.name := 'maintenance';
	l_name := hr_api.employee_label(l_employee);
	hr_api.delete_employee(p_days);
end maintenance_run;
/
