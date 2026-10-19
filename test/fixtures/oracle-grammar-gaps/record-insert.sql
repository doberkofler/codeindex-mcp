declare
	type t_rec is record (report varchar2(10));
	the_data t_rec;
begin
	insert into t values the_data.report;
end;
/
