-- Esquema de Supabase del Revisor de planos (estado final, incluida la migración 20261126).
--
-- Para un proyecto nuevo: pegar entero en el SQL Editor y ejecutar. Es idempotente.
-- Después: cambiar los correos de ejemplo de la sección 6 y subir el video (sección 5).
--
-- Reconstruido a partir del proyecto en uso (columnas, claves y permisos leídos de la API, y la
-- función record_heartbeat tal como estaba). Lo marcado "deducido" no se pudo leer y se escribió
-- según cómo lo usa la app: conviene compararlo con el script original.
--
-- Modelo de seguridad: la app sólo toca estas tablas desde el servidor, con la clave service_role
-- (que saltea RLS). anon y authenticated no tienen ningún permiso: RLS activo y sin políticas.

begin;

-- 1) Lista de habilitados -------------------------------------------------------------------
create table if not exists public.allowed_emails (
  email        text primary key,              -- en minúsculas
  display_name text,
  created_at   timestamptz not null default now()
);

-- 2) Avance del video (una fila por persona) -------------------------------------------------
create table if not exists public.video_progress (
  email              text primary key references public.allowed_emails(email) on delete cascade,
  user_id            uuid references auth.users(id) on delete set null,  -- "on delete": deducido
  credited_seconds   numeric not null default 0,  -- acreditado por el servidor
  last_position      numeric not null default 0,
  duration           numeric not null default 0,
  first_heartbeat_at timestamptz,                 -- inicio, para el tope total
  last_heartbeat_at  timestamptz,                 -- último latido aceptado
  completed_at       timestamptz,                 -- visto al 98 %
  updated_at         timestamptz not null default now()
);
alter table public.video_progress add column if not exists first_heartbeat_at timestamptz;

alter table public.allowed_emails enable row level security;
alter table public.video_progress enable row level security;
revoke all on table public.allowed_emails from anon, authenticated;
revoke all on table public.video_progress from anon, authenticated;
grant select, insert, update, delete on table public.allowed_emails to service_role;
grant select, insert, update, delete on table public.video_progress to service_role;

-- 3) Vista de la lista de avance: todos los habilitados, hayan entrado o no --------------------
-- Definición deducida a partir de sus columnas (email, display_name, completed, completed_at).
create or replace view public.progress_list
with (security_invoker = true) as
select a.email,
       a.display_name,
       (p.completed_at is not null) as completed,
       p.completed_at
  from public.allowed_emails a
  left join public.video_progress p on p.email = a.email;
revoke all on table public.progress_list from anon, authenticated;
grant select on table public.progress_list to service_role;

-- 4) Funciones ------------------------------------------------------------------------------
-- is_allowed(): ¿el correo de la sesión está habilitado? Cuerpo deducido (la app no la usa:
-- compara la lista desde el servidor en lib/guard.ts).
create or replace function public.is_allowed()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $$
  select exists (
    select 1 from public.allowed_emails
     where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- record_heartbeat(): acredita un latido del reproductor. Reglas iguales a lib/video.ts
-- (evaluateBeat); ver supabase/migrations/20261126_video_tope_latidos.sql.
create or replace function public.record_heartbeat(p_email text, p_user_id uuid, p_position numeric, p_duration numeric)
 returns table(out_credited numeric, out_completed boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  c_min_interval constant numeric := 4;     -- s entre latidos aceptados
  c_rate         constant numeric := 1.02;  -- tolerancia proporcional
  c_max_step     constant numeric := 15;    -- s máximos por latido
  c_slack        constant numeric := 2;     -- s fijos: arranque y tope total
  v public.video_progress%rowtype;
  v_pos numeric;
  v_base numeric;
  v_first timestamptz;
  v_step numeric;
  v_cap numeric;
  v_total numeric;
  v_done timestamptz;
begin
  p_email := lower(p_email);
  if not exists (select 1 from public.allowed_emails where email = p_email) then
    raise exception 'cuenta no habilitada';
  end if;

  insert into public.video_progress (email, user_id, duration)
  values (p_email, p_user_id, p_duration)
  on conflict (email) do nothing;

  select * into v from public.video_progress where email = p_email for update;

  if v.completed_at is not null then
    return query select v.credited_seconds, true;
    return;
  end if;

  v_base := greatest(coalesce(v.credited_seconds, 0), 0);

  if v.last_heartbeat_at is not null
     and now() - v.last_heartbeat_at < make_interval(secs => c_min_interval) then
    return query select v_base, false;
    return;
  end if;

  v_pos := least(greatest(coalesce(p_position, 0), 0), p_duration);
  v_first := coalesce(
    v.first_heartbeat_at,
    v.last_heartbeat_at - make_interval(secs => v_base),
    now()
  );

  if v.last_heartbeat_at is null then
    v_step := c_slack;
  else
    v_step := least(extract(epoch from (now() - v.last_heartbeat_at)), c_max_step) * c_rate;
  end if;
  v_cap := greatest(extract(epoch from (now() - v_first)), 0) * c_rate + c_slack;

  v_total := greatest(v_base, round(least(v_pos, v_base + v_step, v_cap, p_duration), 3));
  v_done := case when v_total >= 0.98 * p_duration then now() else null end;

  update public.video_progress
     set user_id = coalesce(p_user_id, user_id),
         credited_seconds = v_total,
         last_position = v_pos,
         duration = p_duration,
         first_heartbeat_at = coalesce(first_heartbeat_at, v_first),
         last_heartbeat_at = now(),
         completed_at = v_done,
         updated_at = now()
   where email = p_email;

  return query select v_total, (v_done is not null);
end;
$function$;

revoke all on function public.is_allowed() from public, anon, authenticated;
grant execute on function public.is_allowed() to service_role;
revoke all on function public.record_heartbeat(text, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.record_heartbeat(text, uuid, numeric, numeric) to service_role;

-- 5) Bucket público del video ----------------------------------------------------------------
-- El archivo se sube a mano: Storage → video → worldteams-intro.mp4 (lib/video.ts → VIDEO_OBJECT).
insert into storage.buckets (id, name, public)
values ('video', 'video', true)
on conflict (id) do update set public = true;

-- 6) Personas habilitadas (CAMBIAR los correos de ejemplo) ------------------------------------
insert into public.allowed_emails (email, display_name) values
  ('it@worldteams.com', 'IT WorldTeams'),
  ('persona@ejemplo.com', 'Persona de ejemplo')
on conflict (email) do nothing;

commit;
