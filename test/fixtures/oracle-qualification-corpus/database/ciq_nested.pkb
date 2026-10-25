create or replace package body ciq_nested as
	procedure run(p_input number) is
		l_total number := 0;
	begin
		<<ciq_loop>>
		for i in 1 .. p_input loop
			l_total := l_total + i;
			exit ciq_loop when l_total > 10;
		end loop ciq_loop;

		declare
			l_local varchar2(20) := ciq_core.choose('nested');
		begin
			l_total := l_total + length(l_local);
		end;
	end run;
end ciq_nested;
/
