-- Migración 2026-11-27: historial de análisis por persona ("Mi actividad").
--
-- Tabla public.analisis: una fila por PDF analizado. SÓLO metadatos (nombre del archivo y
-- conteos). No se guarda el PDF, ni sus textos, ni el texto de los hallazgos.
--
-- Quién puede qué:
--   - Leer: cada persona habilitada, sólo sus filas (email del JWT, en minúsculas, y que siga en
--     allowed_emails). Lo hace la página /historial con la sesión del usuario.
--   - Escribir: nadie desde el navegador. Inserta el endpoint POST /api/historial con service_role.
--   - anon: nada.
--
-- Para la política se habilita a authenticated a ejecutar public.is_allowed(): sólo responde si el
-- correo de la propia sesión está habilitado (la app no la usa para dar acceso; eso sigue en
-- lib/guard.ts).
--
-- Idempotente: se puede correr más de una vez. Pegar entera en el SQL Editor de Supabase.
-- Después, correr supabase/verificar_20261127_historial.sql (debe devolver todo_ok = true).

begin;

-- 1) Tabla ----------------------------------------------------------------------------------
create table if not exists public.analisis (
  id                     uuid primary key default gen_random_uuid(),
  -- Al quitar a alguien de la allowlist se borra su historial (igual que video_progress).
  email                  text not null references public.allowed_emails(email) on delete cascade,
  nombre_archivo         text not null,
  paginas                integer not null,
  paginas_escaneadas     integer not null default 0,
  choques                integer not null default 0,
  duplicados             integer not null default 0,
  cercanias              integer not null default 0,
  paginas_no_verificadas integer not null default 0,
  creado_en              timestamptz not null default now(),
  constraint analisis_email_minusculas  check (email = lower(email)),
  constraint analisis_nombre_largo      check (char_length(nombre_archivo) between 1 and 255),
  constraint analisis_paginas           check (paginas between 1 and 5000),
  constraint analisis_escaneadas        check (paginas_escaneadas between 0 and paginas),
  constraint analisis_no_verificadas    check (paginas_no_verificadas between 0 and paginas),
  constraint analisis_conteos           check (choques between 0 and 1000000
                                               and duplicados between 0 and 1000000
                                               and cercanias between 0 and 1000000)
);

-- La pantalla lista lo último de cada persona; el límite de frecuencia cuenta lo reciente.
create index if not exists analisis_email_creado_en on public.analisis (email, creado_en desc);

-- 2) RLS y permisos -------------------------------------------------------------------------
alter table public.analisis enable row level security;

revoke all on table public.analisis from public, anon, authenticated;
grant select on table public.analisis to authenticated;          -- filtrado por la política
grant select, insert on table public.analisis to service_role;   -- el endpoint del servidor

drop policy if exists analisis_leer_propias on public.analisis;
create policy analisis_leer_propias on public.analisis
  for select
  to authenticated
  using (
    email = lower(coalesce(auth.jwt() ->> 'email', ''))
    and public.is_allowed()
  );
-- Sin políticas de insert/update/delete: aunque alguien tuviera el permiso, RLS lo rechaza.

-- La política la evalúa el rol authenticated: necesita poder ejecutar is_allowed().
revoke all on function public.is_allowed() from public, anon;
grant execute on function public.is_allowed() to authenticated, service_role;

-- 3) Control final: si algo no quedó bien, se deshace todo ---------------------------------
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.analisis'::regclass) then
    raise exception 'RLS no quedó activo en analisis';
  end if;
  if has_table_privilege('anon', 'public.analisis', 'select,insert,update,delete') then
    raise exception 'anon quedó con permisos sobre analisis';
  end if;
  if has_table_privilege('authenticated', 'public.analisis', 'insert,update,delete') then
    raise exception 'authenticated quedó con permiso de escritura sobre analisis';
  end if;
  if not has_table_privilege('service_role', 'public.analisis', 'insert') then
    raise exception 'service_role no puede insertar en analisis';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'analisis' and cmd <> 'SELECT') then
    raise exception 'analisis tiene políticas de escritura';
  end if;
end $$;

commit;
