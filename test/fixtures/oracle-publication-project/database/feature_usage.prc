create or replace procedure use_feature is
	l_id feature_api.t_item.id%type;
begin
	feature_api.write_item(feature_api.g_item, feature_api.g_note);
	l_id := feature_api.g_item.id;
	feature_api.g_item.id := l_id;
	feature_api.external_proc(feature_api.g_note);
end use_feature;
/
