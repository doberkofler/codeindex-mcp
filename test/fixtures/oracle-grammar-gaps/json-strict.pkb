create package body json_strict as
	function f(p_json varchar2) return number is
	begin
		if p_json is json(strict) then
			return 1;
		end if;
		return 0;
	end f;
end json_strict;
/
