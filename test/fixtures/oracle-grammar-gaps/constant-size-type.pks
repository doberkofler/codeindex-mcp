create package const_size as
	k_max constant pls_integer := 10;
	v_value varchar2(k_max char);
end const_size;
/
