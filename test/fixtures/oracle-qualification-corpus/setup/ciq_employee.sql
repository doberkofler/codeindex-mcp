create table ciq_employee (
	employee_id number primary key,
	name varchar2(100),
	salary number
);

insert into ciq_employee (employee_id, name, salary) values (1, 'Ada', 1000);
insert into ciq_employee (employee_id, name, salary) values (2, 'Grace', 2000);

commit;
