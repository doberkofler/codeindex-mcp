create or replace function ciq_standalone_fn(p_value number) return number is
	l_value number := p_value;
begin
	l_value := ciq_core.choose(p_value => l_value);
	return l_value;
end ciq_standalone_fn;
/
