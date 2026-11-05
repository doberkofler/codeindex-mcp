create or replace package body qualification as
	function case_then_routine(p_value boolean) return number is
		l_result number;
	begin
		l_result := case p_value
			when true then 1
			else case p_value
				when false then 0
				else null
			end
		end;
		return l_result;
	end case_then_routine;

	function after_case return number is
	begin
		return case when 1 = 1 then 1 else 0 end;
	end after_case;

	function disabled_branch(p_input number) return number is
		l_value number;
	begin
		$if false $then
			procedure hidden_helper is
			begin
				null;
			end hidden_helper;

			l_value := missing_package.missing_function(p_input);
		$else
			l_value := p_input;
		$end
		return l_value;
	end disabled_branch;

	function literal_true_branch(p_input number) return number is
		l_value number;
	begin
		$if true $then
			l_value := enabled_package.enabled_call(p_input);
		$else
			l_value := disabled_package.disabled_call(p_input);
		$end
		return l_value;
	end literal_true_branch;

	function unknown_branch(p_input number) return number is
		l_value number;
	begin
		$if $$some_feature $then
			l_value := first_package.first_branch(p_input);
		$else
			l_value := second_package.second_branch(p_input);
		$end
		return l_value;
	end unknown_branch;
end qualification;
/
