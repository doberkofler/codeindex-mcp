create or replace package body ciq_dependent as
	function describe_employee(p_id number) return varchar2 is
		l_employee ciq_types.t_employee;
		l_label varchar2(100);
	begin
		l_employee.employee_id := p_id;
		l_employee.name := 'employee-' || to_char(p_id);
		l_label := ciq_types.label(l_employee);
		return l_label || ':' || ciq_core.choose(l_employee.salary);
	end describe_employee;
end ciq_dependent;
/
