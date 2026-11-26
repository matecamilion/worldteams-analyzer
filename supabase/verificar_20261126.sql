-- Verificación de la migración 20261126_video_tope_latidos.sql. Sólo lectura: no cambia nada.
-- Pegar en el SQL Editor después de aplicar la migración. Cada fila debe decir ok = true.

select 'columna first_heartbeat_at existe' as control,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'video_progress'
                  and column_name = 'first_heartbeat_at') as ok
union all
select 'función nueva (con intervalo mínimo)',
       pg_get_functiondef('public.record_heartbeat(text, uuid, numeric, numeric)'::regprocedure) like '%c_min_interval%'
union all
select 'función SECURITY DEFINER',
       (select prosecdef from pg_proc where oid = 'public.record_heartbeat(text, uuid, numeric, numeric)'::regprocedure)
union all
select 'función con search_path fijo',
       (select coalesce(array_to_string(proconfig, ','), '') like '%search_path=public%'
          from pg_proc where oid = 'public.record_heartbeat(text, uuid, numeric, numeric)'::regprocedure)
union all
select 'anon NO ejecuta record_heartbeat',
       not has_function_privilege('anon', 'public.record_heartbeat(text, uuid, numeric, numeric)', 'execute')
union all
select 'authenticated NO ejecuta record_heartbeat',
       not has_function_privilege('authenticated', 'public.record_heartbeat(text, uuid, numeric, numeric)', 'execute')
union all
select 'service_role SÍ ejecuta record_heartbeat',
       has_function_privilege('service_role', 'public.record_heartbeat(text, uuid, numeric, numeric)', 'execute')
union all
select 'anon NO lee allowed_emails',  not has_table_privilege('anon', 'public.allowed_emails', 'select')
union all
select 'anon NO lee video_progress',  not has_table_privilege('anon', 'public.video_progress', 'select')
union all
select 'anon NO lee progress_list',   not has_table_privilege('anon', 'public.progress_list', 'select')
union all
select 'authenticated NO escribe video_progress',
       not has_table_privilege('authenticated', 'public.video_progress', 'insert,update,delete')
union all
select 'RLS activo en allowed_emails',
       (select relrowsecurity from pg_class where oid = 'public.allowed_emails'::regclass)
union all
select 'RLS activo en video_progress',
       (select relrowsecurity from pg_class where oid = 'public.video_progress'::regclass)
union all
select 'filas con latidos tienen inicio registrado',
       not exists (select 1 from public.video_progress
                    where last_heartbeat_at is not null and first_heartbeat_at is null)
union all
select 'filas completas siguen completas',
       not exists (select 1 from public.video_progress
                    where credited_seconds >= 0.98 * duration and duration > 0 and completed_at is null);

-- Detalle de las filas (sin cambios esperados en las completas):
select email, credited_seconds, first_heartbeat_at, last_heartbeat_at, completed_at
  from public.video_progress
 order by email;
