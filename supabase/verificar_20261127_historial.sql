-- Verificación de la migración 20261127_historial_analisis.sql. Devuelve UNA fila: cada columna
-- es un control (true = bien) y todo_ok resume todos.
--
-- Además de mirar permisos y políticas, simula los roles reales: inserta una fila de prueba para
-- la primera persona habilitada y prueba leer/escribir como anon, como un usuario NO habilitado,
-- como la dueña de la fila y como otra persona habilitada. Todo corre en una transacción que
-- termina en ROLLBACK: no queda nada guardado. Pegar entera en el SQL Editor y ejecutar.

begin;

create temp table _verif (control text primary key, ok boolean not null) on commit drop;

do $$
declare
  v_owner  text := (select email from public.allowed_emails order by email limit 1);
  v_other  text := (select email from public.allowed_emails order by email offset 1 limit 1);
  v_n      integer;
  v_ok     boolean;
  -- JWT de prueba (sólo lo que mira la política: el email).
  claims   constant text := '{"role":"authenticated","email":"%s"}';
begin
  -- Estructura y permisos declarados --------------------------------------------------------
  insert into _verif values
    ('tabla_existe', to_regclass('public.analisis') is not null),
    ('rls_activo', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.analisis')), false)),
    ('anon_sin_permisos', not has_table_privilege('anon', 'public.analisis', 'select,insert,update,delete')),
    ('authenticated_sin_escritura', not has_table_privilege('authenticated', 'public.analisis', 'insert,update,delete')),
    ('service_role_inserta', has_table_privilege('service_role', 'public.analisis', 'insert')),
    ('solo_politica_select', (select count(*) = 1 and bool_and(cmd = 'SELECT')
                                from pg_policies where schemaname = 'public' and tablename = 'analisis')),
    -- Sólo metadatos: exactamente estas columnas (nada de textos del plano ni de hallazgos).
    ('solo_metadatos', (select array_agg(column_name::text order by column_name)
                          from information_schema.columns
                         where table_schema = 'public' and table_name = 'analisis')
                       = array['cercanias','choques','creado_en','duplicados','email','id','nombre_archivo',
                               'paginas','paginas_escaneadas','paginas_no_verificadas']);

  if v_owner is null then
    insert into _verif values ('hay_personas_habilitadas_para_simular', false);
    return;
  end if;

  -- Fila de prueba (se deshace con el ROLLBACK del final).
  insert into public.analisis (email, nombre_archivo, paginas) values (v_owner, 'verificacion.pdf', 1);

  -- anon: no lee ni escribe -----------------------------------------------------------------
  begin
    set local role anon;
    perform 1 from public.analisis limit 1;
    v_ok := false;
  exception when others then v_ok := sqlstate = '42501';  -- 42501: sin permiso o rechazado por RLS
  end;
  reset role;
  insert into _verif values ('anon_no_lee', v_ok);

  begin
    set local role anon;
    insert into public.analisis (email, nombre_archivo, paginas) values (v_owner, 'x.pdf', 1);
    v_ok := false;
  exception when others then v_ok := sqlstate = '42501';  -- 42501: sin permiso o rechazado por RLS
  end;
  reset role;
  insert into _verif values ('anon_no_escribe', v_ok);

  -- Usuario autenticado NO habilitado: no ve nada y no escribe -------------------------------
  perform set_config('request.jwt.claims', format(claims, 'no-habilitado@ejemplo.invalid'), true);
  set local role authenticated;
  select count(*) into v_n from public.analisis;
  reset role;
  insert into _verif values ('no_habilitado_no_lee', v_n = 0);

  begin
    set local role authenticated;
    insert into public.analisis (email, nombre_archivo, paginas) values ('no-habilitado@ejemplo.invalid', 'x.pdf', 1);
    v_ok := false;
  exception when others then v_ok := sqlstate = '42501';  -- 42501: sin permiso o rechazado por RLS
  end;
  reset role;
  insert into _verif values ('no_habilitado_no_escribe', v_ok);

  -- La dueña (habilitada): ve sólo sus filas y no puede escribir desde el navegador -----------
  perform set_config('request.jwt.claims', format(claims, upper(v_owner)), true);  -- mayúsculas: igual matchea
  set local role authenticated;
  select count(*) into v_n from public.analisis where nombre_archivo = 'verificacion.pdf';
  v_ok := v_n >= 1 and not exists (select 1 from public.analisis where email <> v_owner);
  reset role;
  insert into _verif values ('habilitada_lee_solo_lo_suyo', v_ok);

  begin
    set local role authenticated;
    update public.analisis set choques = 99 where email = v_owner;
    v_ok := false;
  exception when others then v_ok := sqlstate = '42501';  -- 42501: sin permiso o rechazado por RLS
  end;
  reset role;
  insert into _verif values ('habilitada_no_modifica', v_ok);

  begin
    set local role authenticated;
    delete from public.analisis where email = v_owner;
    v_ok := false;
  exception when others then v_ok := sqlstate = '42501';  -- 42501: sin permiso o rechazado por RLS
  end;
  reset role;
  insert into _verif values ('habilitada_no_borra', v_ok);

  -- Otra persona habilitada no ve las filas de la primera (si hay una segunda) ---------------
  if v_other is not null then
    perform set_config('request.jwt.claims', format(claims, v_other), true);
    set local role authenticated;
    select count(*) into v_n from public.analisis where email = v_owner;
    reset role;
    insert into _verif values ('otra_habilitada_no_ve_ajenas', v_n = 0);
  end if;
end $$;

select bool_and(ok)                                                     as todo_ok,
       bool_and(ok) filter (where control = 'tabla_existe')              as tabla_existe,
       bool_and(ok) filter (where control = 'rls_activo')                as rls_activo,
       bool_and(ok) filter (where control = 'solo_metadatos')            as solo_metadatos,
       bool_and(ok) filter (where control = 'solo_politica_select')      as solo_politica_select,
       bool_and(ok) filter (where control = 'anon_sin_permisos')         as anon_sin_permisos,
       bool_and(ok) filter (where control = 'anon_no_lee')               as anon_no_lee,
       bool_and(ok) filter (where control = 'anon_no_escribe')           as anon_no_escribe,
       bool_and(ok) filter (where control = 'authenticated_sin_escritura') as authenticated_sin_escritura,
       bool_and(ok) filter (where control = 'no_habilitado_no_lee')      as no_habilitado_no_lee,
       bool_and(ok) filter (where control = 'no_habilitado_no_escribe')  as no_habilitado_no_escribe,
       bool_and(ok) filter (where control = 'habilitada_lee_solo_lo_suyo') as habilitada_lee_solo_lo_suyo,
       bool_and(ok) filter (where control = 'habilitada_no_modifica')    as habilitada_no_modifica,
       bool_and(ok) filter (where control = 'habilitada_no_borra')       as habilitada_no_borra,
       bool_and(ok) filter (where control = 'otra_habilitada_no_ve_ajenas') as otra_habilitada_no_ve_ajenas,
       bool_and(ok) filter (where control = 'service_role_inserta')      as service_role_inserta,
       string_agg(control, ', ') filter (where not ok)                   as fallan
  from _verif;

rollback;
