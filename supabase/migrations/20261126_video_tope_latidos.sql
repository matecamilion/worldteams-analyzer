-- Migración 2026-11-26: acreditación del video a prueba de latidos inventados.
--
-- Antes: record_heartbeat acreditaba hasta (tiempo transcurrido + 1 s) por latido, sin intervalo
-- mínimo. Mandando latidos muy seguidos, el video se completaba en mucho menos que su duración.
--
-- Ahora (mismas reglas que lib/video.ts → evaluateBeat):
--   1. Un latido a menos de 4 s del último aceptado se ignora: no acredita ni mueve la hora.
--   2. Cada latido acredita como mucho el tiempo real transcurrido × 1,02 (máximo 15 s).
--      El primero sólo marca el inicio (hasta 2 s).
--   3. Tope total: lo acreditado nunca supera (tiempo real desde el primer latido) × 1,02 + 2 s.
--      Para eso se agrega video_progress.first_heartbeat_at.
--   4. El crédito nunca baja y nunca pasa la duración. Se completa al 98 %.
--
-- Idempotente: se puede correr más de una vez. Mantiene los permisos: la función sólo la ejecuta
-- service_role. Pegar entera en el SQL Editor de Supabase y ejecutar.

begin;

-- 1) Columna nueva, sin romper filas existentes.
alter table public.video_progress
  add column if not exists first_heartbeat_at timestamptz;

-- Filas con avance previo y sin inicio registrado: se estima el inicio como
-- (último latido − segundos acreditados), para que el tope total no las frene.
-- Las filas sin latidos quedan en null y se completan con el primer latido.
update public.video_progress
   set first_heartbeat_at = last_heartbeat_at - make_interval(secs => coalesce(credited_seconds, 0))
 where first_heartbeat_at is null
   and last_heartbeat_at is not null;

-- 2) Función con las reglas nuevas (misma firma y mismo tipo de retorno).
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

  -- Fila bloqueada: dos latidos simultáneos se procesan de a uno.
  select * into v from public.video_progress where email = p_email for update;

  if v.completed_at is not null then
    return query select v.credited_seconds, true;
    return;
  end if;

  v_base := greatest(coalesce(v.credited_seconds, 0), 0);

  -- Intervalo mínimo: latido demasiado seguido → no se acredita ni se actualiza la hora.
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

-- 3) Permisos: sólo service_role.
revoke all on function public.record_heartbeat(text, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.record_heartbeat(text, uuid, numeric, numeric) to service_role;

-- 4) Control final: si los permisos no quedaron bien, se deshace todo.
do $$
begin
  if has_function_privilege('anon', 'public.record_heartbeat(text, uuid, numeric, numeric)', 'execute')
     or has_function_privilege('authenticated', 'public.record_heartbeat(text, uuid, numeric, numeric)', 'execute') then
    raise exception 'record_heartbeat quedó ejecutable por anon/authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.record_heartbeat(text, uuid, numeric, numeric)', 'execute') then
    raise exception 'service_role no puede ejecutar record_heartbeat';
  end if;
end $$;

commit;
