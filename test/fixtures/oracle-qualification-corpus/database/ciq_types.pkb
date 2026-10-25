create or replace package body ciq_types as
	g_private constant number := 1;

	function label(p_employee t_employee) return t_name is
		l_name t_name := p_employee.name;
	begin
		g_last_id := p_employee.employee_id;
		return l_name || to_char(g_private);
	end label;

	procedure reset is
	begin
		g_last_id := 0;
	end reset;
begin
	g_last_id := c_default_salary;
end ciq_types;
/
