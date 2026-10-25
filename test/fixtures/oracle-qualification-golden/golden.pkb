create or replace package body golden_api as
	function run(p_value in number) return number is
	begin
		pragma inline(run, 'YES');
		return run(p_value) + 1;
	end run;
end golden_api;
/
