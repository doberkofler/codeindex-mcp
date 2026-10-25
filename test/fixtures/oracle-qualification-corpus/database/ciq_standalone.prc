create or replace procedure ciq_standalone_prc(p_id number, p_label out varchar2) is
	l_employee ciq_types.t_employee;

	procedure nested_reset(p_employee in out ciq_types.t_employee) is
	begin
		p_employee.employee_id := p_id;
		p_employee.name := 'reset';
	end nested_reset;
begin
	nested_reset(l_employee);
	p_label := ciq_dependent.describe_employee(l_employee.employee_id);
end ciq_standalone_prc;
/
