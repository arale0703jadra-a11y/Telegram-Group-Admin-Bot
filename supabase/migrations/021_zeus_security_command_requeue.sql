-- 021_zeus_security_command_requeue.sql
--
-- Migración PREPARADA para aplicación controlada. NO aplicar en producción sin
-- autorización del propietario y sin verificar antes, en el proyecto real, que
-- existe el índice único `security_commands_operation_key_idx` con la
-- definición esperada. El bloque de comprobaciones de esta migración falla de
-- forma explícita si falta una dependencia: no hay modo degradado inseguro.
--
-- Objetivo (auditoría Fase 1): consumir el estado stale de una orden y crear la
-- orden de reintento en UNA sola transacción, de modo que CERBERO no pueda
-- reclamar la original mientras ZEUS crea la copia.
--
-- Contrato de CERBERO que se respeta (no se modifica ningún objeto suyo):
--   * `claim_security_command` (CERBERO 011) sólo reclama filas con
--     status='processing' AND result_state='processing' AND lease vencido AND
--     execution_started_at IS NULL.
--   * `markCommandExecutionStarted` (helper TypeScript de CERBERO,
--     `CERBERO/src/database/repositories/commands-repository.ts`) exige
--     status='processing', result_state='processing',
--     processing_instance_id y processing_token del reclamante,
--     execution_started_at NULL y lease vivo.
--   * `completeCommand` y `renewCommandLease` (helpers TypeScript del mismo
--     repositorio) exigen result_state='processing' y lease vivo. No son objetos
--     SQL de la migración CERBERO 011.
-- Por eso neutralizar la original (result_state='unknown' + limpiar
-- instance/token/processing_at/lease) la vuelve inalcanzable para CERBERO,
-- reutilizando exactamente el mismo estado que produce su propia recuperación
-- (CERBERO 011). No se inventa un estado nuevo ni se toca su CHECK.
--
-- Dependencias: CERBERO 009 (operation_key + índice único) y CERBERO 011
-- (execution_started_at).
--
-- Esta migración NO inserta datos, NO altera tablas y NO modifica CERBERO.
--
-- Guardas de la Fase 3 (revisión de auditoría):
--   * `p_acknowledged` debe ser `true`: sin confirmación explícita la función
--     devuelve `confirmation_required` y no escribe nada (fail-closed).
--   * El preflight exige que `security_commands_operation_key_idx` sea UNIQUE y
--     cubra exactamente (group_id, action, operation_key), no sólo que el
--     nombre exista.
--   * El espejo `security_audit_log` registra `command_id`, `group_id` y
--     `target_user_id` para que la fila sea trazable.
--
-- Guardas de la Fase 4D (revisión de auditoría, hallazgos E4/E5):
--   * Los parámetros `p_max_attempts`, `p_max_retry_depth` y
--     `p_mute_min_remaining_seconds` NO pueden relajar la política: sólo
--     endurecerla. El valor efectivo se recorta contra techos internos
--     (5 intentos, profundidad 3, 30 s de ventana mínima), de modo que una
--     llamada con `p_mute_min_remaining_seconds => 0` no puede convertir un
--     mute vencido en permanente. Paridad con `MAX_SECURITY_COMMAND_ATTEMPTS`,
--     `MAX_SECURITY_COMMAND_RETRY_DEPTH` y `MUTE_MIN_REMAINING_MS`.
--   * `unique_violation` se clasifica: sólo se informa `already_retried` cuando
--     la colisión es del índice de idempotencia Y existe la fila ganadora. En
--     cualquier otro caso se propaga el error y la transacción completa se
--     revierte (nunca se neutraliza una orden sin crear su reintento).

begin;

do $$
declare
  v_index_unique boolean;
  v_index_columns text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_commands'
       and column_name = 'operation_key'
  ) then
    raise exception
      '021: falta security_commands.operation_key (aplicar CERBERO 009 antes)';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_commands'
       and column_name = 'execution_started_at'
  ) then
    raise exception
      '021: falta security_commands.execution_started_at (aplicar CERBERO 011 antes)';
  end if;

  -- El índice debe existir, ser UNIQUE y cubrir exactamente
  -- (group_id, action, operation_key): el nombre por sí solo no es garantía.
  -- CERBERO 009 lo crea como índice único parcial, así que se acepta un
  -- predicado; lo que no se acepta es un índice no único o con otras columnas.
  -- Se consulta el catálogo (`pg_index`/`pg_attribute`) en lugar de analizar el
  -- texto de `pg_indexes`, para que el orden y el formato no importen.
  select i.indisunique into v_index_unique
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_namespace n on n.oid = ic.relnamespace
   where n.nspname = 'public'
     and ic.relname = 'security_commands_operation_key_idx'
     and i.indrelid = 'public.security_commands'::regclass;

  if v_index_unique is null then
    raise exception
      '021: falta el índice único security_commands_operation_key_idx (CERBERO 009)';
  end if;

  if v_index_unique is not true then
    raise exception
      '021: security_commands_operation_key_idx existe pero no es UNIQUE';
  end if;

  select array_to_string(array_agg(a.attname::text order by a.attname::text), ',')
    into v_index_columns
    from pg_attribute a
   where a.attrelid = (
           select i.indexrelid
             from pg_index i
             join pg_class ic on ic.oid = i.indexrelid
             join pg_namespace n on n.oid = ic.relnamespace
            where n.nspname = 'public'
              and ic.relname = 'security_commands_operation_key_idx'
         )
     and a.attnum > 0
     and not a.attisdropped;

  if v_index_columns is distinct from 'action,group_id,operation_key' then
    raise exception
      '021: security_commands_operation_key_idx debe indexar exactamente (group_id, action, operation_key); encontrado: %',
      coalesce(v_index_columns, '(ninguna columna)');
  end if;

  -- Auditoría transaccional obligatoria: sin estas columnas la RPC no puede
  -- registrar el reintento y se prefiere no crear la función.
  if (
    select count(*)
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_events'
       and column_name in ('group_id', 'event_type', 'user_id', 'details')
  ) <> 4 then
    raise exception
      '021: security_events debe tener group_id, event_type, user_id y details';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'security_events'
       and column_name = 'event_type'
       and data_type = 'USER-DEFINED'
  ) then
    raise exception
      '021: security_events.event_type es un enum; añadir el valor security_command_requeued antes de aplicar esta migración';
  end if;

  -- El espejo en security_audit_log es secundario: si su esquema difiere, la
  -- RPC lo omite con un warning y la auditoría vive en security_events.
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public'
       and table_name = 'security_audit_log'
  ) then
    raise warning
      '021: security_audit_log ausente; la auditoría quedará sólo en security_events';
  end if;
end;
$$;

create or replace function public.zeus_requeue_security_command(
  p_command_id uuid,
  p_group_id bigint,
  p_actor_id bigint,
  p_reason text,
  p_acknowledged boolean,
  p_retry_key_suffix text default '#retry',
  p_max_retry_depth integer default 3,
  p_max_attempts integer default 5,
  p_mute_min_remaining_seconds integer default 30
)
returns table (
  outcome text,
  original_command_id uuid,
  retry_command_id uuid,
  original_status text,
  original_result_state text,
  original_execution_started_at timestamptz,
  original_attempts integer,
  retry_operation_key text,
  detail text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.security_commands%rowtype;
  v_outcome text;
  v_detail text;
  v_base_key text;
  v_retry_key text;
  v_suffix text;
  v_depth integer := 0;
  v_existing_retry uuid;
  v_until timestamptz;
  v_retry_id uuid;
  v_updated integer := 0;
  v_stale boolean := false;
  -- Techos internos no relajables (Fase 4D, E4). Son constantes del cuerpo, no
  -- parámetros: ningún llamador con `service_role` puede ampliarlos.
  c_max_attempts constant integer := 5;
  c_max_retry_depth constant integer := 3;
  c_mute_min_remaining_seconds constant integer := 30;
  v_max_attempts integer;
  v_max_retry_depth integer;
  v_mute_min_remaining_seconds integer;
  v_constraint_name text;
  -- Misma lista que REPLAYABLE_SECURITY_ACTIONS en
  -- src/services/security-command-recovery.ts. Si divergen, la prueba de
  -- integración contra PostgreSQL real falla.
  v_allowed_actions constant text[] := array[
    'MUTE_USER',
    'UNMUTE_USER',
    'BAN_USER',
    'UNBAN_USER',
    'UPDATE_SECURITY_CONFIG',
    'UPDATE_PROTECTED_USER'
  ];
begin
  if p_command_id is null
     or p_group_id is null
     or p_actor_id is null
     or p_actor_id <= 0 then
    return query select
      'invalid_request'::text, p_command_id, null::uuid, null::text,
      null::text, null::timestamptz, null::integer, null::text,
      'identificadores incompletos'::text;
    return;
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    return query select
      'invalid_request', p_command_id, null::uuid, null::text,
      null::text, null::timestamptz, null::integer, null::text,
      'motivo obligatorio para auditar el reintento';
    return;
  end if;

  v_suffix := coalesce(p_retry_key_suffix, '#retry');
  if btrim(v_suffix) = '' then
    return query select
      'invalid_request', p_command_id, null::uuid, null::text,
      null::text, null::timestamptz, null::integer, null::text,
      'sufijo de reintento vacío';
    return;
  end if;

  -- Fase 4D / E4: recorte de los parámetros de política. El llamador sólo puede
  -- endurecer (valores más estrictos que el defecto), nunca relajar; el valor
  -- efectivo queda siempre en el rango seguro.
  --   * attempts: [1, 5]. Un 0 o negativo se eleva a 1 (nunca un no-op opaco).
  --   * retry depth: [0, 3], paridad exacta con MAX_SECURITY_COMMAND_RETRY_DEPTH.
  --   * mute window: [30 s, 24 h]. El mínimo es lo que impide que un
  --     `until_date` ya vencido pase el filtro y Telegram lo haga permanente:
  --     con `p_mute_min_remaining_seconds => 0` el agujero volvía a abrirse.
  v_max_attempts := least(
    greatest(coalesce(p_max_attempts, c_max_attempts), 1),
    c_max_attempts
  );
  v_max_retry_depth := least(
    greatest(coalesce(p_max_retry_depth, c_max_retry_depth), 0),
    c_max_retry_depth
  );
  v_mute_min_remaining_seconds := least(
    greatest(
      coalesce(p_mute_min_remaining_seconds, c_mute_min_remaining_seconds),
      c_mute_min_remaining_seconds
    ),
    86400
  );

  -- Bloqueo de fila: serializa esta operación con cualquier reclamación,
  -- renovación o cierre de CERBERO sobre la misma orden.
  select * into v_row
    from public.security_commands
   where id = p_command_id
     and group_id = p_group_id
   for update;

  if not found then
    v_outcome := 'not_found';
  elsif v_row.status <> 'processing' then
    v_outcome := 'not_processing';
    v_detail := v_row.status;
  elsif v_row.result_state in ('completed', 'failed', 'cancelled') then
    v_outcome := 'not_processing';
    v_detail := v_row.result_state;
  elsif v_row.result_state is null
        or v_row.result_state not in ('processing', 'unknown') then
    v_outcome := 'unsupported_result_state';
    v_detail := coalesce(v_row.result_state, 'null');
  elsif v_row.execution_started_at is not null then
    -- Prueba positiva de inicio: nunca se repite, ni con confirmación.
    v_outcome := 'execution_may_have_started';
    v_detail := v_row.execution_started_at::text;
  else
    v_stale := case
      when v_row.result_state = 'unknown' then true
      when v_row.lease_expires_at is not null then v_row.lease_expires_at <= now()
      when v_row.processing_at is not null
        then v_row.processing_at <= now() - interval '5 minutes'
      else false
    end;

    if v_row.result_state = 'processing' and not v_stale then
      v_outcome := 'not_stale';
    end if;
  end if;
  if v_outcome is null
     and coalesce(v_row.attempts, 0) >= v_max_attempts then
    v_outcome := 'attempts_exhausted';
    v_detail := coalesce(v_row.attempts, 0)::text;
  end if;

  if v_outcome is null and v_row.action <> all (v_allowed_actions) then
    v_outcome := 'not_retryable';
    v_detail := v_row.action;
  end if;

  if v_outcome is null
     and v_row.action = 'MUTE_USER'
     and v_row.payload ? 'until_date' then
    -- Un until_date vencido (o a menos de 30 s) hace que Telegram convierta el
    -- mute en permanente. Se rechaza en lugar de agravar la sanción.
    begin
      if jsonb_typeof(v_row.payload -> 'until_date') <> 'number' then
        v_outcome := 'temporal_window_expired';
        v_detail := 'until_date no numérico';
      else
        v_until := to_timestamp((v_row.payload ->> 'until_date')::double precision);
        if v_until <= now() + make_interval(
             secs => v_mute_min_remaining_seconds
           ) then
          v_outcome := 'temporal_window_expired';
          v_detail := 'until_date vencido o demasiado próximo';
        end if;
      end if;
    exception when others then
      v_outcome := 'temporal_window_expired';
      v_detail := 'until_date no interpretable';
    end;
  end if;

  if v_outcome is null then
    v_base_key := btrim(coalesce(v_row.operation_key, ''));
    if v_base_key = '' then
      v_outcome := 'missing_operation_key';
    else
      v_retry_key := v_base_key;
      while right(v_retry_key, length(v_suffix)) = v_suffix loop
        v_depth := v_depth + 1;
        v_retry_key := left(v_retry_key, length(v_retry_key) - length(v_suffix));
      end loop;
      v_retry_key := v_base_key || v_suffix;

      if v_depth >= v_max_retry_depth then
        v_outcome := 'retry_limit_reached';
        v_detail := v_base_key;
      end if;
    end if;
  end if;

  if v_outcome is null then
    select sc.id into v_existing_retry
      from public.security_commands sc
     where sc.group_id = v_row.group_id
       and sc.action = v_row.action
       and sc.operation_key = v_retry_key
     for update;

    if v_existing_retry is not null then
      v_outcome := 'already_retried';
      v_detail := v_existing_retry::text;
    end if;
  end if;

  -- Una copia pendiente sólo tiene sentido si CERBERO puede reclamarla.
  if v_outcome is null and not exists (
    select 1
      from public.groups g
      join public.group_bot_bindings gb
        on gb.group_id = g.chat_id
       and gb.enabled = true
      join public.bots b
        on b.id = gb.bot_id
       and b.name = 'Cerbero'
       and b.type = 'security'
     where g.chat_id = v_row.group_id
       and g.active = true
  ) then
    v_outcome := 'group_not_eligible';
    v_detail := 'grupo inactivo o sin binding habilitado con Cerbero';
  end if;

  -- Fail-closed: repetir la intención puede revertir una decisión humana
  -- posterior (un desbaneo hecho después, un mute nuevo, un cambio de
  -- configuración), así que la RPC no ejecuta nada sin confirmación explícita.
  -- La política TS (`evaluateSecurityCommandReplayPolicy`) ya la exige;
  -- repetirla aquí impide que una llamada directa con `service_role` salte la
  -- única salvaguarda humana del diseño.
  if v_outcome is null and coalesce(p_acknowledged, false) is not true then
    v_outcome := 'confirmation_required';
    v_detail := 'acknowledgeLaterHumanDecisions es obligatorio para repetir una orden';
  end if;

  if v_outcome is null then
    -- Neutralización atómica: mismo estado que produce CERBERO 011 cuando no
    -- puede demostrar que la ejecución no comenzó. A partir de aquí la orden
    -- original ya no es reclamable ni renovable.
    update public.security_commands
       set result_state = 'unknown',
           last_error = concat_ws(
             '; ',
             'Superseded by ZEUS requeue; original intent moved to a new order.',
             nullif(btrim(coalesce(v_row.last_error, '')), '')
           ),
           processing_instance_id = null,
           processing_token = null,
           processing_at = null,
           lease_expires_at = null
     where id = v_row.id
       and status = 'processing'
       and result_state = v_row.result_state;

    -- El bloqueo `for update` debería garantizar 1 fila; si no, se aborta el
    -- reintento en lugar de duplicar una orden que alguien más ya movio.
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      v_outcome := 'concurrent_change';
      v_detail := 'la orden cambio entre la lectura y la escritura';
    end if;
  end if;

  if v_outcome is null then
    begin
      insert into public.security_commands (
        group_id,
        action,
        target_user_id,
        target_message_id,
        payload,
        status,
        operation_key,
        result_state
      )
      values (
        v_row.group_id,
        v_row.action,
        v_row.target_user_id,
        v_row.target_message_id,
        coalesce(v_row.payload, '{}'::jsonb),
        'pending',
        v_retry_key,
        'queued'
      )
      returning id into v_retry_id;
    exception when unique_violation then
      -- Fase 4D / E5: `unique_violation` no identifica por sí sola qué
      -- restricción falló. Sólo hay dos desenlaces aceptables:
      --   a) la colisión es del índice de idempotencia
      --      (`security_commands_operation_key_idx`) y existe la fila ganadora:
      --      la subtransacción revierte el INSERT, la neutralización anterior se
      --      conserva y se informa `already_retried` con el ganador.
      --   b) cualquier otra restricción única, o una colisión del índice sin
      --      ganador verificable: NO se puede afirmar que exista un reintento.
      --      Se propaga el error para revertir la sentencia completa: neutralizar
      --      la original sin crear su copia la dejaría inejecutable y, además,
      --      afirmaría ante el operador un reintento inexistente. ZEUS traduce el
      --      error a `unexpected_rpc_outcome` con revisión humana.
      get stacked diagnostics v_constraint_name = constraint_name;
      v_retry_id := null;
      select sc.id into v_existing_retry
        from public.security_commands sc
       where sc.group_id = v_row.group_id
         and sc.action = v_row.action
         and sc.operation_key = v_retry_key;

      if v_existing_retry is null
         or (
           v_constraint_name is not null
           and v_constraint_name <> 'security_commands_operation_key_idx'
         ) then
        raise;
      end if;

      v_outcome := 'already_retried';
      v_detail := v_existing_retry::text;
    end;
  end if;

  if v_outcome is null and v_retry_id is null then
    -- Salvaguarda: sin id no se puede auditar ni devolver un éxito verificable.
    raise exception '021: la inserción del reintento no devolvió id';
  end if;

  if v_outcome is null then
    -- Auditoría en la misma transacción: si falla, no se crea el reintento.
    insert into public.security_events (group_id, event_type, user_id, details)
    values (
      v_row.group_id,
      'security_command_requeued',
      v_row.target_user_id,
      jsonb_build_object(
        'source', 'zeus.requeueSecurityCommand',
        'outcome', 'requeued',
        'actorId', p_actor_id,
        'reason', left(p_reason, 500),
        'originalCommandId', v_row.id,
        'retryCommandId', v_retry_id,
        'action', v_row.action,
        'originalStatus', v_row.status,
        'originalResultState', v_row.result_state,
        'originalExecutionStartedAt', v_row.execution_started_at,
        'originalAttempts', coalesce(v_row.attempts, 0),
        'retryOperationKey', v_retry_key,
        'acknowledgedLaterHumanDecisions', coalesce(p_acknowledged, false)
      )
    );

    -- Espejo en la tabla heredada de auditoría. Es secundario a propósito: si
    -- su esquema (tipos, columnas obligatorias, CHECK) no coincide con esta
    -- escritura, el reintento y la auditoría de security_events se mantienen y
    -- el warning queda en el log del motor.
    begin
      insert into public.security_audit_log (
        action,
        executed_by,
        result,
        command_id,
        group_id,
        target_user_id
      )
      values (
        'security_command_requeue',
        'zeus:' || p_actor_id::text,
        left(
          format(
            'group=%s original=%s retry=%s action=%s reason=%s',
            v_row.group_id,
            v_row.id,
            v_retry_id,
            v_row.action,
            btrim(p_reason)
          ),
          1000
        ),
        -- Trazabilidad: sin estas tres columnas el espejo no permite unir la
        -- fila con la orden, el grupo ni la persona afectada (CERBERO 007 las
        -- añade como nullable). Si un proyecto no las tiene, el bloque de
        -- excepción de abajo lo degrada a warning.
        v_retry_id,
        v_row.group_id,
        v_row.target_user_id
      );
    exception
      when undefined_table
        or undefined_column
        or datatype_mismatch
        or not_null_violation
        or foreign_key_violation
        or check_violation
        or invalid_text_representation then
        raise warning
          '021: security_audit_log no admite el registro del reintento (%); la auditoría queda en security_events',
          sqlerrm;
    end;

    v_outcome := 'requeued';
    v_detail := v_retry_id::text;
  end if;

  return query select
    coalesce(v_outcome, 'concurrent_change'),
    coalesce(v_row.id, p_command_id),
    v_retry_id,
    -- Cast explícito: si el estado fuese un enum, la firma text seguiría siendo
    -- válida y la comparación con la política TS no cambia.
    v_row.status::text,
    v_row.result_state::text,
    v_row.execution_started_at,
    coalesce(v_row.attempts, 0),
    case when v_outcome = 'requeued' then v_retry_key else null end,
    v_detail;
end;
$$;

revoke all on function public.zeus_requeue_security_command(
  uuid, bigint, bigint, text, boolean, text, integer, integer, integer
) from public, anon, authenticated;

grant execute on function public.zeus_requeue_security_command(
  uuid, bigint, bigint, text, boolean, text, integer, integer, integer
) to service_role;

commit;

