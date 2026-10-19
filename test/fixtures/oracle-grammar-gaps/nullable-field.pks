create package nullable_field as
	type t_rec is record (
		a_date date null
	);
end nullable_field;
/
