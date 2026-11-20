import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getInternalSupabaseClient } from "../supabase.js";
import type { WarningEntry } from "../storage/types.js";
import { isAuthorizedPanelUser } from "../security/panel-authorization.js";
import {
  hasGroupAdministrativeStatus,
  hasSecurityCommandAuthority,
  type GroupMembership,
} from "../security/group-authority.js";
import {
  MAX_SECURITY_COMMAND_RETRY_DEPTH,
  SECURITY_COMMAND_RETRY_SUFFIX,
  STALE_PROCESSING_GRACE_MS,
  classifySecurityCommandEvidence,
  evaluateSecurityCommandReplayPolicy,
  isReplayableSecurityAction,
  isSecurityCommandId,
  isSecurityCommandRequeueRefusalReason,
  isStaleSecurityCommandRow,
  type SecurityCommandEvidenceState,
  type SecurityCommandRequeueRefusalReason,
} from "./security-command-recovery.js";


export type SecurityAction =
  | "DELETE_MESSAGE"
  | "MUTE_USER"
  | "UNMUTE_USER"
  | "BAN_USER"
  | "UNBAN_USER"
  | "KICK_USER"
  | "UPDATE_SECURITY_CONFIG"
  | "UPDATE_PROTECTED_USER"
  | "WARN_USER"
  | "UNWARN_USER"
  | "UNWARN_ALL"
  | "CLEAN_MESSAGES";

export interface SecurityCommandPayload {
  requester_id?: number;
  requester_name?: string;
  reason?: string;
  duration_minutes?: number;
  /**
   * Instante absoluto en segundos (epoch). `null` es representable en el `jsonb`
   * de `security_commands.payload`, y la migración 021 lo rechaza explícitamente
   * (`jsonb_typeof(...) <> 'number'`); por eso el tipo lo admite (hallazgo B1).
   */
  until_date?: number | null;
  message_ids?: number[];
  warn_limit?: number;
  warn_action?: "mute" | "ban" | "none";
  [key: string]: unknown;
}

export interface SecurityWarningRecord extends WarningEntry {
  revokedAt: string | null;
  commandId: string | null;
}

export interface SecurityCommandInput {
  groupId: number;
  action: SecurityAction;
  targetUserId?: number;
  targetMessageId?: number;
  payload?: SecurityCommandPayload;
  idempotencyKey?: string;
}

export type SecurityCommandResultState =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface SecurityCommandRow {
  id: string;
  group_id: number;
  action: SecurityAction;
  target_user_id: number | null;
  target_message_id: number | null;
  payload: SecurityCommandPayload;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  created_at: string;
  executed_at: string | null;
  processing_instance_id: string | null;
  processing_token: string | null;
  lease_expires_at: string | null;
  processing_at: string | null;
  attempts: number;
  last_error: string | null;
  responsible_bot: string | null;
  cancelled_at: string | null;
  operation_key: string | null;
  result_state: SecurityCommandResultState | null;
  /**
   * Marca que CERBERO escribe inmediatamente antes de ejecutar la acción
   * externa. `null` significa que la ejecución no llegó a comenzar desde la
   * perspectiva del contrato (CERBERO 011). ZEUS la lee como evidencia y nunca
   * reencola una orden que la tenga.
   */
  execution_started_at: string | null;
}

interface EnqueuedSecurityCommand extends SecurityCommandRow {
  deduplicated: boolean;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = canonicalizeValue(
          (value as Record<string, unknown>)[key],
        );
        return accumulator;
      }, {});
  }
  return value;
}

/**
 * Campos de payload que no forman parte de la intención de la operación.
 *
 * Cambiar el nombre visible del solicitante o el `username` cacheado del
 * usuario protegido no convierte una solicitud en otra distinta: si esos
 * campos entraran en la clave, dos clics equivalentes generarían órdenes
 * diferentes y la deduplicación no protegería de nada.
 */
const OPERATION_KEY_VOLATILE_PAYLOAD_FIELDS = [
  "requester_name",
  "username",
] as const;

export function buildSecurityCommandOperationKey(
  input: Pick<
    SecurityCommandInput,
    | "groupId"
    | "action"
    | "targetUserId"
    | "targetMessageId"
    | "payload"
    | "idempotencyKey"
  >,
): string | undefined {
  if (!input.idempotencyKey) return undefined;
  const payload = normalizeSecurityPayload(input.payload);
  if (input.payload?.until_date === undefined) {
    delete payload.until_date;
  }
  for (const field of OPERATION_KEY_VOLATILE_PAYLOAD_FIELDS) {
    delete payload[field];
  }
  const normalized = canonicalizeValue({
    idempotencyKey: input.idempotencyKey,
    groupId: input.groupId,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    targetMessageId: input.targetMessageId ?? null,
    payload,
  });
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

export function getSecurityCommandResultState(
  row: Partial<SecurityCommandRow> | undefined,
): SecurityCommandResultState {
  const state = row?.result_state ?? row?.status ?? "unknown";
  if (state === "pending" || state === "queued") return "queued";
  if (state === "unknown") return "unknown";
  if (state === "processing") {
    if (row?.lease_expires_at && new Date(row.lease_expires_at).getTime() < Date.now()) {
      return "unknown";
    }
    return "processing";
  }
  if (state === "completed" || state === "failed" || state === "cancelled") {
    return state;
  }
  return "unknown";
}

let cerberoId: string | undefined;

/**
 * Sin caché local a propósito.
 *
 * `getInternalSupabaseClient()` valida `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
 * en cada llamada y devuelve otra instancia cuando cambian (fingerprint), de
 * modo que una caché por módulo sólo podía servir credenciales antiguas
 * después de `resetSupabaseClients()` (auditoría Fase 7).
 */
function getClient(): SupabaseClient {
  return getInternalSupabaseClient();
}

export async function initializeCerbero(
  options: { client?: SupabaseClient } = {},
): Promise<void> {
  const db = options.client ?? getClient();
  const { data, error } = await db
    .from("bots")
    .select("id")
    .eq("name", "Cerbero")
    .eq("type", "security")
    .maybeSingle();
  if (error) throw error;
  if (data?.id) {
    cerberoId = data.id as string;
    return;
  }

  const { data: created, error: insertError } = await db
    .from("bots")
    .insert({
      name: "Cerbero",
      type: "security",
      status: "offline",
      instance_id: process.env.CERBERO_INSTANCE_ID ?? "cerbero-primary",
      version: "1.0.0",
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  if (!created?.id) throw new Error("Supabase no devolvió el ID de Cerbero.");
  cerberoId = created.id as string;
}

export async function ensureCerberoBinding(
  groupId: number,
  options: { client?: SupabaseClient } = {},
): Promise<void> {
  const db = options.client ?? getClient();
  const { data: bot, error: botError } = await db
    .from("bots")
    .select("id")
    .eq("name", "Cerbero")
    .eq("type", "security")
    .maybeSingle();
  if (botError) throw botError;
  if (!bot) {
    await initializeCerbero(options);
  }
  const cerbero = bot ?? (cerberoId ? { id: cerberoId } : undefined);
  if (!cerbero) throw new Error("Cerbero no pudo registrarse en Supabase.");
  const { error: groupError } = await db
    .from("groups")
    .upsert(
      { chat_id: groupId, active: true },
      { onConflict: "chat_id", ignoreDuplicates: true },
    );
  if (groupError) throw groupError;
  const { error: bindingError } = await db
    .from("group_bot_bindings")
    .upsert(
      { group_id: groupId, bot_id: cerbero.id, enabled: true, permissions: {} },
      { onConflict: "group_id,bot_id" },
    );
  if (bindingError) throw bindingError;
}

export async function enqueueSecurityCommand(
  input: SecurityCommandInput,
  options: { client?: SupabaseClient } = {},
): Promise<EnqueuedSecurityCommand> {
  await ensureCerberoBinding(input.groupId, options);
  const payload = normalizeSecurityPayload(input.payload);
  const operationKey = buildSecurityCommandOperationKey(input);
  const client = options.client ?? getClient();

  if (operationKey) {
    const { data: existing, error: existingError } = await client
      .from("security_commands")
      .select("*")
      .eq("group_id", input.groupId)
      .eq("action", input.action)
      .eq("operation_key", operationKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      return { ...(existing as SecurityCommandRow), deduplicated: true };
    }
  }

  const { data, error } = await client
    .from("security_commands")
    .insert({
      group_id: input.groupId,
      action: input.action,
      target_user_id: input.targetUserId ?? null,
      target_message_id: input.targetMessageId ?? null,
      payload,
      status: "pending",
      operation_key: operationKey ?? null,
      result_state: "queued",
    })
    .select("*")
    .single();
  if (error) {
    if (operationKey && error.code === "23505") {
      const { data: existing, error: lookupError } = await client
        .from("security_commands")
        .select("*")
        .eq("group_id", input.groupId)
        .eq("action", input.action)
        .eq("operation_key", operationKey)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) {
        return { ...(existing as SecurityCommandRow), deduplicated: true };
      }
    }
    throw error;
  }
  return { ...(data as SecurityCommandRow), deduplicated: false };
}

export function isCerberoExecutionEnabled(): boolean {
  return process.env.SECURITY_EXECUTION_MODE === "cerbero";
}

export async function delegateSecurityCommand(
  input: SecurityCommandInput,
): Promise<
  | { ok: true; queued: true; commandId: string; duplicate: boolean }
  | { ok: false; error: string }
> {
  try {
    const command = await enqueueSecurityCommand(input);
    return {
      ok: true,
      queued: true,
      commandId: command.id,
      duplicate: command.deduplicated,
    };
  } catch (error) {
    console.error("[ZEUS] No se pudo enviar la orden a Cerbero:", error);
    return {
      ok: false,
      error: "No se pudo enviar la orden de seguridad a Cerbero.",
    };
  }
}

function normalizeSecurityPayload(
  payload: SecurityCommandPayload | undefined,
): SecurityCommandPayload {
  const normalized = { ...(payload ?? {}) };
  if (
    normalized.duration_minutes === undefined &&
    typeof normalized.minutes === "number"
  ) {
    normalized.duration_minutes = normalized.minutes;
  }
  if (
    normalized.until_date === undefined &&
    typeof normalized.duration_minutes === "number"
  ) {
    normalized.until_date =
      Math.floor(Date.now() / 1000) + normalized.duration_minutes * 60;
  }
  return normalized;
}

export async function getSecurityCommand(
  commandId: string,
): Promise<SecurityCommandRow | undefined> {
  const { data, error } = await getClient()
    .from("security_commands")
    .select(
      "id,group_id,action,target_user_id,target_message_id,payload,status,created_at,executed_at,processing_instance_id,processing_token,lease_expires_at,processing_at,attempts,last_error,responsible_bot,cancelled_at,operation_key,result_state,execution_started_at",
    )
    .eq("id", commandId)
    .maybeSingle();
  if (error) throw error;
  return (data as SecurityCommandRow | null) ?? undefined;
}

export async function getSecurityWarnings(
  groupId: number,
  userId: number,
): Promise<SecurityWarningRecord[]> {
  const { data, error } = await getClient()
    .from("security_warnings")
    .select("id,user_id,requester_id,requester_name,reason,created_at,revoked_at,command_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((warning) => ({
    id: warning.id,
    userId: warning.user_id,
    adminId: warning.requester_id ?? 0,
    adminName: warning.requester_name ?? "Desconocido",
    date: warning.created_at,
    reason: warning.reason,
    revokedAt: warning.revoked_at,
    commandId: warning.command_id,
  }));
}

export async function getSecurityWarningHistory(
  groupId: number,
  userId: number,
): Promise<SecurityWarningRecord[]> {
  const { data, error } = await getClient()
    .from("security_warnings")
    .select("id,user_id,requester_id,requester_name,reason,created_at,revoked_at,command_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((warning) => ({
    id: warning.id,
    userId: warning.user_id,
    adminId: warning.requester_id ?? 0,
    adminName: warning.requester_name ?? "Desconocido",
    date: warning.created_at,
    reason: warning.reason,
    revokedAt: warning.revoked_at,
    commandId: warning.command_id,
  }));
}

export interface CerberoStatus {
    status: string;
    instanceId: string;
    lastHeartbeatAt?: string;
    version?: string;
    recentErrors?: number;
    activeGroups?: number;
  }

export interface SecurityEventSummary {
    id: string;
    eventType: string;
    userId?: number;
    details: Record<string, unknown>;
    createdAt: string;
  }

export interface SecurityCommandHistoryItem {
  id: string;
  action: SecurityAction;
  status: SecurityCommandRow["status"];
  created_at: string;
  executed_at: string | null;
  lease_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  resultState: SecurityCommandResultState;
}

export async function getSecurityEventsForUser(
  groupId: number,
  userId: number,
  limit = 10,
): Promise<SecurityEventSummary[]> {
  const { data, error } = await getClient()
    .from("security_events")
    .select("id,event_type,user_id,details,created_at")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((event) => ({
    id: event.id,
    eventType: event.event_type,
    userId: event.user_id ?? undefined,
    details: event.details ?? {},
    createdAt: event.created_at,
  }));
}

export async function getSecurityCommandHistoryForUser(
  groupId: number,
  userId: number,
  limit = 10,
): Promise<SecurityCommandHistoryItem[]> {
  const { data, error } = await getClient()
    .from("security_commands")
    .select("id,action,status,result_state,created_at,executed_at,lease_expires_at,attempts,last_error")
    .eq("group_id", groupId)
    .eq("target_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    action: row.action as SecurityAction,
    status: row.status as SecurityCommandRow["status"],
    created_at: row.created_at,
    executed_at: row.executed_at,
    lease_expires_at: row.lease_expires_at,
    attempts: row.attempts ?? 0,
    last_error: row.last_error,
    resultState: getSecurityCommandResultState(row as Partial<SecurityCommandRow>),
  }));
}

  export interface SecurityStats {
    deletedMessages: number;
    mutedUsers: number;
    bannedUsers: number;
    kickedUsers: number;
    alerts: number;
    blockedLinks: number;
    spamDetected: number;
    blockedContent: number;
    lastAction?: SecurityEventSummary;
  }

  export interface SecurityUserProfile {
    userId: number;
    username?: string;
    warnings: number;
    protected: boolean;
    protectionType?: string;
    events: SecurityEventSummary[];
    admin?: boolean;
    owner?: boolean;
    verified?: boolean;
  }

  export interface SecurityGroupConfig {
    group_id: number;
    enabled: boolean;
    safe_mode: boolean;
    sanctions_enabled: boolean;
    mode: "alert" | "automatic";
    anti_spam: boolean;
    anti_flood: boolean;
    anti_links: boolean;
    anti_content: boolean;
    media_protection: boolean;
    prohibited_words: string[];
    allowed_link_domains: string[];
    warning_two_action: "delete" | "mute" | "kick" | "ban";
    warning_three_action: "kick" | "ban";
    warning_four_action: "ban";
    reincidence_enabled: boolean;
    rules: Record<string, { enabled: boolean; severity: "low" | "medium" | "high" | "critical"; action: "detect" | "delete" | "warn" | "mute" | "kick" | "ban" }>;
    sticker_limit: number;
    media_limit: number;
  }

export async function getCerberoStatus(): Promise<CerberoStatus | undefined> {
    const { data, error } = await getClient()
      .from("bots")
      .select("status, instance_id, last_heartbeat_at, version")
      .eq("name", "Cerbero")
      .order("last_heartbeat_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    return {
      status: data.status,
      instanceId: data.instance_id,
      lastHeartbeatAt: data.last_heartbeat_at ?? undefined,
      version: data.version ?? undefined,
      recentErrors: await getRecentErrorCount(),
      activeGroups: await getConnectedSecurityGroupsCount(),
    };
  }

  async function getRecentErrorCount(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await getClient()
      .from("security_events")
      .select("id", { count: "exact", head: true })
      .in("event_type", ["moderation_failed", "security_action_failed"])
      .gte("created_at", since);
    if (error) throw error;
    return count ?? 0;
  }

  async function getConnectedSecurityGroupsCount(): Promise<number> {
    const { count, error } = await getClient()
      .from("group_bot_bindings")
      .select("group_id", { count: "exact", head: true })
      .eq("enabled", true);
    if (error) throw error;
    return count ?? 0;
  }

export async function getSecurityEvents(
    groupId: number,
    limit = 10,
  ): Promise<SecurityEventSummary[]> {
    const { data, error } = await getClient()
      .from("security_events")
      .select("id,event_type,user_id,details,created_at")
      .eq("group_id", groupId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((event) => ({
      id: event.id,
      eventType: event.event_type,
      userId: event.user_id ?? undefined,
      details: event.details ?? {},
      createdAt: event.created_at,
    }));
  }

export async function getConnectedSecurityGroups(): Promise<
    Array<{ chatId: number; title?: string; active: boolean }>
  > {
    const { data, error } = await getClient()
      .from("groups")
      .select("chat_id,title,active")
      .eq("active", true)
      .order("title");
    if (error) throw error;
    return (data ?? []).map((group) => ({
      chatId: group.chat_id,
      title: group.title ?? undefined,
      active: group.active,
    }));
}

export async function getSecurityConfig(groupId: number): Promise<SecurityGroupConfig> {
  const { data, error } = await getClient()
    .from("security_group_configs")
    .select("*")
    .eq("group_id", groupId)
    .maybeSingle();
  if (error) throw error;
  const config = ({
    group_id: groupId,
    enabled: true,
    safe_mode: false,
    sanctions_enabled: true,
    mode: "alert",
    anti_spam: true,
    anti_flood: true,
    anti_links: true,
    anti_content: true,
    media_protection: true,
    prohibited_words: [],
    allowed_link_domains: [],
    warning_two_action: "mute",
    warning_three_action: "kick",
    warning_four_action: "ban",
    reincidence_enabled: true,
    rules: {},
    sticker_limit: 5,
    media_limit: 8,
    ...(data ?? {}),
  }) as SecurityGroupConfig;
  return {
    ...config,
    prohibited_words: Array.isArray(config.prohibited_words) ? config.prohibited_words : [],
    allowed_link_domains: Array.isArray(config.allowed_link_domains) ? config.allowed_link_domains : [],
    rules: config.rules && typeof config.rules === "object" ? config.rules : {},
  };
}
/**
 * Ventana de deduplicación de acciones manuales (Fase 5).
 *
 * Una clave determinista y *permanente* sería peligrosa con el índice único
 * actual: el mismo mute al mismo usuario con la misma duración colisionaría
 * para siempre y la segunda sanción legítima nunca se ejecutaría. Por eso la
 * intención incluye un cubo temporal: dos clics equivalentes dentro de la
 * ventana producen la misma clave (protección contra doble pulsación) y fuera
 * de ella producen órdenes independientes.
 */
export const MANUAL_ACTION_IDEMPOTENCY_WINDOW_MS = 10_000;

/** Ventana de deduplicación para cambios de configuración y lista blanca. */
export const PANEL_INTENT_IDEMPOTENCY_WINDOW_MS = 30_000;

export interface PanelIntentKeyOptions {
  now?: () => number;
  windowMs?: number;
}

export interface SecurityCommandEnqueueOptions extends PanelIntentKeyOptions {
  client?: SupabaseClient;
  idempotencyKey?: string;
}

function idempotencyBucket(now: number, windowMs: number): number {
  const safeWindow =
    Number.isFinite(windowMs) && windowMs > 0
      ? Math.trunc(windowMs)
      : PANEL_INTENT_IDEMPOTENCY_WINDOW_MS;
  return Math.floor(now / safeWindow);
}

function buildPanelIntentKey(
  scope: string,
  fields: Record<string, unknown>,
  options: PanelIntentKeyOptions,
  defaultWindowMs: number,
): string {
  const readClock = options.now ?? Date.now;
  const windowMs = options.windowMs ?? defaultWindowMs;
  const bucket = idempotencyBucket(readClock(), windowMs);
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        canonicalizeValue({
          scope,
          bucket,
          ...fields,
        }),
      ),
    )
    .digest("hex");
  return `${scope}:${bucket}:${digest}`;
}

function withoutVolatileFields(
  payload: Record<string, unknown> | SecurityCommandPayload | undefined,
): Record<string, unknown> {
  const copy = { ...(payload ?? {}) } as Record<string, unknown>;
  for (const field of OPERATION_KEY_VOLATILE_PAYLOAD_FIELDS) {
    delete copy[field];
  }
  return copy;
}

/**
 * Clave de intención para `enqueueManualSecurityAction`.
 *
 * El `until_date` derivado de `duration_minutes` no se incluye (aún no existe
 * en el payload del solicitante); si el llamador envía un `until_date`
 * absoluto, sí forma parte de la intención.
 */
export function buildManualSecurityActionIdempotencyKey(
  input: {
    groupId: number;
    userId: number;
    action: SecurityAction;
    payload?: Record<string, unknown> | SecurityCommandPayload;
    targetMessageId?: number;
  },
  options: PanelIntentKeyOptions = {},
): string {
  const payload = withoutVolatileFields(input.payload);
  const messageId =
    input.targetMessageId ??
    (typeof payload.messageId === "number" ? payload.messageId : null);
  return buildPanelIntentKey(
    "manual_security_action",
    {
      groupId: input.groupId,
      userId: input.userId,
      action: input.action,
      targetMessageId: messageId,
      payload,
    },
    options,
    MANUAL_ACTION_IDEMPOTENCY_WINDOW_MS,
  );
}

/** Clave de intención para `updateSecurityConfig` (actualización parcial). */
export function buildSecurityConfigIdempotencyKey(
  groupId: number,
  changes: Record<string, unknown>,
  options: PanelIntentKeyOptions = {},
): string {
  return buildPanelIntentKey(
    "security_config_update",
    { groupId, changes: withoutVolatileFields(changes) },
    options,
    PANEL_INTENT_IDEMPOTENCY_WINDOW_MS,
  );
}

/** Clave de intención para `updateProtectedUser`. */
export function buildProtectedUserUpdateIdempotencyKey(
  input: {
    groupId: number;
    userId: number;
    enabled: boolean;
    protectionType?: string;
  },
  options: PanelIntentKeyOptions = {},
): string {
  return buildPanelIntentKey(
    "protected_user_update",
    {
      groupId: input.groupId,
      userId: input.userId,
      enabled: input.enabled,
      protectionType: input.protectionType ?? "vip",
    },
    options,
    PANEL_INTENT_IDEMPOTENCY_WINDOW_MS,
  );
}



export async function updateSecurityConfig(
  groupId: number,
  changes: Partial<Omit<SecurityGroupConfig, "group_id">>,
  idempotencyKey?: string,
  options: SecurityCommandEnqueueOptions = {},
): Promise<void> {
  const key =
    idempotencyKey ??
    buildSecurityConfigIdempotencyKey(
      groupId,
      changes as Record<string, unknown>,
      options,
    );
  await enqueueSecurityCommand(
    {
      groupId,
      action: "UPDATE_SECURITY_CONFIG",
      idempotencyKey: key,
      payload: changes,
    },
    { client: options.client },
  );
}

export async function updateProtectedUser(
  groupId: number,
  userId: number,
  enabled: boolean,
  username?: string,
  options: SecurityCommandEnqueueOptions = {},
): Promise<void> {
  const key =
    options.idempotencyKey ??
    buildProtectedUserUpdateIdempotencyKey(
      { groupId, userId, enabled, protectionType: "vip" },
      options,
    );
  await enqueueSecurityCommand(
    {
      groupId,
      action: "UPDATE_PROTECTED_USER",
      targetUserId: userId,
      idempotencyKey: key,
      payload: { enabled, username, protectionType: "vip" },
    },
    { client: options.client },
  );
}

export async function isSecurityProtectedUser(
  groupId: number,
  userId: number,
): Promise<boolean> {
  const { data, error } = await getClient()
    .from("security_protected_users")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function getSecurityUserProfile(
  groupId: number,
  userId: number,
): Promise<SecurityUserProfile> {
  const { data: protectedUser, error: protectedError } = await getClient()
    .from("security_protected_users")
    .select("username,protection_type")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (protectedError) throw protectedError;
  const events = await getSecurityEventsForUser(groupId, userId);
  const latestUsername = events.find((event) => event.details.username)?.details.username;
  return {
    userId,
    username: protectedUser?.username ?? (typeof latestUsername === "string" ? latestUsername : undefined),
    warnings: events.filter((event) => event.eventType === "security_violation").length,
    protected: Boolean(protectedUser),
    protectionType: protectedUser?.protection_type ?? undefined,
    events,
  };
}

export async function clearSecurityWarnings(groupId: number, userId: number): Promise<void> {
  const { error } = await getClient()
    .from("security_events")
    .delete()
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .eq("event_type", "security_violation");
  if (error) throw error;
}

export async function enqueueManualSecurityAction(
  groupId: number,
  userId: number,
  action: "MUTE_USER" | "BAN_USER" | "KICK_USER" | "DELETE_MESSAGE",
  payload: Record<string, unknown> = {},
  options: SecurityCommandEnqueueOptions = {},
): Promise<void> {
  if (action === "DELETE_MESSAGE" && !payload.messageId) {
    const events = await getSecurityEventsForUser(groupId, userId);
    const messageIds = events
      .map((event) => event.details.messageId)
      .filter((id): id is number => typeof id === "number")
      .slice(0, 20);
    for (const messageId of messageIds) {
      // Cada mensaje es una intención distinta: la clave debe incluir el id,
      // de lo contrario las 20 órdenes colapsarían en una sola.
      const key =
        options.idempotencyKey ??
        buildManualSecurityActionIdempotencyKey(
          { groupId, userId, action, payload, targetMessageId: messageId },
          options,
        );
      await enqueueSecurityCommand(
        {
          groupId,
          targetUserId: userId,
          targetMessageId: messageId,
          action,
          payload,
          idempotencyKey: key,
        },
        { client: options.client },
      );
    }
    return;
  }
  const messageId =
    typeof payload.messageId === "number" ? payload.messageId : undefined;
  const key =
    options.idempotencyKey ??
    buildManualSecurityActionIdempotencyKey(
      { groupId, userId, action, payload, targetMessageId: messageId },
      options,
    );
  await enqueueSecurityCommand(
    { groupId, targetUserId: userId, action, payload, idempotencyKey: key },
    { client: options.client },
  );
}

export async function getSecurityStats(groupId: number): Promise<SecurityStats> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const events = await getSecurityEventsSince(groupId, since);
  const stats: SecurityStats = {
    deletedMessages: 0, mutedUsers: 0, bannedUsers: 0, kickedUsers: 0,
    alerts: 0, blockedLinks: 0, spamDetected: 0, blockedContent: 0,
    lastAction: events[0],
  };
  for (const event of events) {
    const details = event.details;
    const action = typeof details.actionPerformed === "string" ? details.actionPerformed : "";
    const normalizedAction = action.toLowerCase();
    if (normalizedAction.includes("delete")) stats.deletedMessages++;
    if (normalizedAction.includes("mute")) stats.mutedUsers++;
    if (normalizedAction.includes("ban_user") || normalizedAction === "ban") stats.bannedUsers++;
    if (normalizedAction.includes("kick")) stats.kickedUsers++;
    if (event.eventType === "security_violation") stats.alerts++;
    if (details.violationType === "excessive_links") stats.blockedLinks++;
    if (typeof details.violationType === "string" && ["flood", "spam_repeated", "repeat_offender"].includes(details.violationType)) {
      stats.spamDetected++;
    }
    if (event.eventType === "prohibited_content_detected") stats.blockedContent++;
  }
  return stats;
}

async function getSecurityEventsSince(groupId: number, since: string): Promise<SecurityEventSummary[]> {
  const { data, error } = await getClient()
    .from("security_events")
    .select("id,event_type,user_id,details,created_at")
    .eq("group_id", groupId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return (data ?? []).map((event) => ({
    id: event.id,
    eventType: event.event_type,
    userId: event.user_id ?? undefined,
    details: event.details ?? {},
    createdAt: event.created_at,
  }));
}

/**
 * Grace period used when an order is `processing` but CERBERO did not publish a
 * lease expiry. Se reexporta desde la política pura para no duplicar el valor.
 */
export { STALE_PROCESSING_GRACE_MS };

export const STALE_PROCESSING_RECONCILED_ERROR =
  "Stale processing detected by ZEUS reconciliation; order available for re-enqueue.";

/**
 * Acciones que pueden repetirse *en principio*, siempre con confirmación
 * explícita del operador. La política completa (ventana de mute, evidencia de
 * ejecución, límites) vive en `security-command-recovery.ts`.
 *
 * `KICK_USER` ya no está en la lista: CERBERO lo ejecuta como `ban` +
 * `unban(only_if_banned)`, así que una repetición puede desbanear a un usuario
 * baneado después por una persona.
 */
export function isRetrySafeSecurityAction(action: SecurityAction): boolean {
  return isReplayableSecurityAction(action);
}

/**
 * `true` cuando una orden `processing` perdió su lease. Delegado a la política
 * pura para que la regla exista en un único lugar.
 */
export function isStaleProcessingRow(
  row: Pick<SecurityCommandRow, "status" | "lease_expires_at" | "processing_at">,
  now: number = Date.now(),
): boolean {
  return isStaleSecurityCommandRow(row, now);
}

export interface StaleSecurityCommandSummary {
  id: string;
  groupId: number;
  action: SecurityAction;
  targetUserId: number | null;
  attempts: number;
  leaseExpiresAt: string | null;
  processingAt: string | null;
  resultState: SecurityCommandResultState | null;
  /** Evidencia positiva de inicio escrita por CERBERO antes de ejecutar. */
  executionStartedAt: string | null;
  /** Clasificación exigida por la Fase 3. */
  evidence: SecurityCommandEvidenceState;
  retryable: boolean;
  /** True when the order already carries previous evidence in `last_error`. */
  hasEvidence: boolean;
  /** La orden no debe repetirse automáticamente: requiere revisión humana. */
  requiresHumanReview: boolean;
}

function summarizeStaleRow(row: Record<string, unknown>): StaleSecurityCommandSummary {
  const action = row.action as SecurityAction;
  const resultState =
    typeof row.result_state === "string"
      ? (row.result_state as SecurityCommandResultState)
      : null;
  const executionStartedAt =
    typeof row.execution_started_at === "string" ? row.execution_started_at : null;
  const evidence = classifySecurityCommandEvidence({
    status: typeof row.status === "string" ? row.status : null,
    result_state: resultState,
    execution_started_at: executionStartedAt,
  });
  return {
    id: String(row.id ?? ""),
    groupId: Number(row.group_id),
    action,
    targetUserId:
      typeof row.target_user_id === "number" ? row.target_user_id : null,
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    leaseExpiresAt:
      typeof row.lease_expires_at === "string" ? row.lease_expires_at : null,
    processingAt:
      typeof row.processing_at === "string" ? row.processing_at : null,
    resultState,
    executionStartedAt,
    evidence,
    retryable: isRetrySafeSecurityAction(action),
    hasEvidence:
      typeof row.last_error === "string" && row.last_error.trim().length > 0,
    requiresHumanReview:
      evidence === "maybe_started" || evidence === "reconciled_unknown",
  };
}

/**
 * Alcance de la consulta de órdenes `processing` (Fase 4D, hallazgo E1).
 *
 * - `"awaiting"`: sólo órdenes que todavía esperan una decisión de ZEUS
 *   (`result_state = 'processing'` y sin marca de inicio). Es el alcance de la
 *   reconciliación: una orden ya reconciliada (`result_state = 'unknown'`) deja
 *   de competir por los primeros `maxResults` puestos.
 * - `"all"`: no filtra por `result_state`; devuelve lo que la política de
 *   staleness acepte. Incluye órdenes ya reconciliadas **sólo si conservan
 *   `lease_expires_at` o `processing_at`** (`isStaleProcessingRow` devuelve
 *   `false` cuando ambos son NULL, que es el estado que dejan CERBERO 011 y el
 *   reencolado). Es el alcance por defecto del listado: no cambia el
 *   comportamiento previo de `listStaleSecurityCommands`.
 *
 * Consecuencia conocida: este listado **no** sirve para revisar órdenes
 * `unknown` ya neutralizadas (sin lease y sin `processing_at`). Esa vista
 * requiere una consulta dedicada por `result_state='unknown'`, que no existe
 * todavía; ver el informe de la Fase 4D (recomendación P-1).
 */
export type StaleProcessingScope = "awaiting" | "all";

async function selectStaleProcessingRows(options: {
  maxResults?: number;
  now?: () => number;
  client?: SupabaseClient;
  scope?: StaleProcessingScope;
}): Promise<StaleSecurityCommandSummary[]> {
  const { maxResults = 100, now = Date.now, scope = "all" } = options;
  const db = options.client ?? getClient();
  let query = db
    .from("security_commands")
    .select(
      "id,group_id,action,target_user_id,status,result_state,lease_expires_at,processing_at,attempts,last_error,execution_started_at",
    )
    .eq("status", "processing");

  // Filtro en SQL, no sólo en memoria (E1). `status` no cambia cuando ZEUS
  // reconcilia: la orden sigue en `processing` con `result_state='unknown'`.
  // Ordenando por `created_at ASC` y aplicando el límite antes de comprobar la
  // staleness, 100 órdenes ya reconciliadas (las más antiguas) consumían el lote
  // completo en cada ciclo y las órdenes nuevas nunca se examinaban: una ceguera
  // silenciosa, porque el resultado se contabilizaba como `unchanged`.
  if (scope === "awaiting") {
    query = query
      .eq("result_state", "processing")
      // Una orden con marca de inicio es evidencia positiva: la política la
      // excluye igualmente, así que no debe ocupar cupo del lote.
      .is("execution_started_at", null);
  }

  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(1, Math.trunc(maxResults)), 500));
  if (error) throw error;

  const reference = now();
  return (data ?? [])
    .filter((row) =>
      isStaleProcessingRow(
        {
          status: "processing",
          lease_expires_at:
            typeof row.lease_expires_at === "string"
              ? row.lease_expires_at
              : null,
          processing_at:
            typeof row.processing_at === "string" ? row.processing_at : null,
        },
        reference,
      ),
    )
    .map((row) => summarizeStaleRow(row as Record<string, unknown>))
    .filter((row) => row.id.length > 0);
}

/**
 * Lists orders that CERBERO claimed and abandoned (expired lease).
 *
 * Read-only: it never executes, re-enqueues or deletes an order. Operators use
 * it together with `requeueSecurityCommand` to decide what to replay.
 */
export async function listStaleSecurityCommands(
  options: {
    maxResults?: number;
    now?: () => number;
    /** Inyección para pruebas; por defecto el cliente de servicio de ZEUS. */
    client?: SupabaseClient;
    /**
     * `"all"` (por defecto) mantiene el comportamiento previo: incluye las
     * órdenes ya reconciliadas que aún conservan lease o `processing_at`.
     * `"awaiting"` muestra sólo las que todavía no se han reconciliado.
     *
     * Ni una ni otra listan órdenes `unknown` ya neutralizadas (lease y
     * `processing_at` NULL): esa vista dedicada no existe todavía (P-1).
     */
    scope?: StaleProcessingScope;
  } = {},
): Promise<StaleSecurityCommandSummary[]> {
  return selectStaleProcessingRows(options);
}

/**
 * Reconciliation of orders stuck in a CERBERO "processing" state.
 *
 * CERBERO claims orders (claim_security_command) and marks them
 * `result_state = "processing"`. If CERBERO crashes or is restarted while the
 * lease (`lease_expires_at`) has expired, the order stays "processing" and
 * cannot be claimed by another instance. ZEUS keeps this function to detect
 * those stale orders, mark them as `result_state = "unknown"` and preserve
 * them for re-enqueue, without executing or deleting the order.
 *
 * Rules applied (idempotent and safe):
 * - Only orders with `status = "processing"` are considered.
 * - Sólo se leen las que todavía esperan decisión (`result_state =
 *   "processing"` y `execution_started_at IS NULL`). Las ya reconciliadas
 *   (`result_state = "unknown"`) y las que tienen marca de inicio quedan fuera
 *   de la consulta: si se leyeran, su antigüedad las colocaría en cabeza del
 *   lote y, al no poder reescribirse, consumirían los `maxResults` puestos en
 *   cada ciclo (Fase 4D, E1: bloqueo de cabeza de línea).
 * - Only orders whose lease is expired, or orders with no lease after the
 *   grace window, are reconciled.
 * - Orders that already have evidence in `last_error` are never overwritten:
 *   they remain as they are so that traceability is kept.
 * - The write repeats the lease condition and `execution_started_at IS NULL`,
 *   so a fresh claim by CERBERO — or a start mark written between the read and
 *   the update — is never clobbered.
 * - Each call is limited with `maxResults` and is idempotent: it does not
 *   re-enqueue anything; it only marks orders as recoverable.
 *
 * Concurrency: no existe un guard de instancia única en el repositorio. Se
 * asume una sola réplica de ZEUS (Railway debe estar configurado así). Si por
 * error se ejecutaran dos instancias, la operación sigue siendo segura: el
 * UPDATE repite las condiciones en el WHERE, así que la segunda instancia
 * actualiza 0 filas en lugar de pisar una reclamación de CERBERO. Lo que no
 * puede tolerar el sistema es que ambas instancias hagan polling del mismo
 * token (Telegram responde 409); ver RUNBOOK.md, sección 13.
 */
export async function reconcileStaleSecurityCommands(
  options: {
    maxResults?: number;
    now?: () => number;
    client?: SupabaseClient;
  } = {},
): Promise<{
  matched: number;
  reconciled: number;
  unchanged: number;
  commandIds: string[];
}> {
  const db = options.client ?? getClient();
  const { now = Date.now } = options;
  const stale = await selectStaleProcessingRows({ ...options, scope: "awaiting" });
  const reconciledAt = new Date(now()).toISOString();
  const commandIds: string[] = [];
  let unchanged = 0;

  for (const command of stale) {
    if (command.hasEvidence || command.evidence === "maybe_started") {
      // Nunca se sobrescribe la evidencia previa ni la marca de inicio
      // (`execution_started_at`): son prueba de que la orden pudo ejecutarse.
      unchanged += 1;
      continue;
    }
    const { data: updated, error: updateError } = await db
      .from("security_commands")
      .update({
        result_state: "unknown",
        last_error: STALE_PROCESSING_RECONCILED_ERROR,
      })
      .eq("id", command.id)
      .eq("status", "processing")
      // El estado leído también se repite en el WHERE: si la orden pasó a
      // `unknown` entre la lectura y la escritura (otra réplica de ZEUS, o una
      // reconciliación anterior), no se reescribe ni se cuenta como reconciliada.
      .eq("result_state", "processing")
      // Fence en la base de datos: la fila se leyó sin marca de inicio, pero
      // CERBERO pudo escribir `execution_started_at` entre la lectura y esta
      // escritura. Repetir la condición en el WHERE (como ya se hace con el
      // lease) deja la autoridad en PostgreSQL en lugar de en la copia en
      // memoria: sin esto se marcaría `unknown` una orden con prueba positiva
      // de ejecución.
      .is("execution_started_at", null)
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${reconciledAt}`)
      .select("id");
    if (updateError) throw updateError;
    if (updated && updated.length > 0) {
      commandIds.push(command.id);
    } else {
      // CERBERO re-claimed or completed the order in the meantime.
      unchanged += 1;
    }
  }

  return {
    matched: stale.length,
    reconciled: commandIds.length,
    unchanged,
    commandIds,
  };
}


export type SecurityCommandRequeueResult =
  | { ok: true; commandId: string; retriedFrom: string }
  | {
      ok: false;
      reason: SecurityCommandRequeueRefusalReason;
      detail?: string;
      /** La orden no debe repetirse automáticamente: requiere revisión humana. */
      requiresHumanReview?: boolean;
    };

/**
 * Profundidad máxima de la cadena `<clave>#retry`. Se reexporta desde la
 * política pura para que la constante exista una sola vez.
 */
export { MAX_SECURITY_COMMAND_RETRY_DEPTH };

export interface SecurityCommandRequeueOptions {
  /** Grupo desde cuyo contexto se solicita el reintento (obligatorio). */
  groupId: number;
  /** Operador del panel que solicita la operación (queda auditado). */
  actorId: number;
  /** Motivo obligatorio: se persiste con el reintento. */
  reason: string;
  /**
   * Confirmación explícita de que la repetición puede revertir una decisión
   * humana posterior. Sin ella la operación se rechaza.
   */
  acknowledgeLaterHumanDecisions?: boolean;
  /**
   * Membresía del operador en el grupo, obtenida de Telegram mediante
   * `loadGroupMembership` (patrón de `admin-guardian.ts`). Sin ella no hay
   * autorización: no se consulta ningún registro local.
   */
  groupMembership?: GroupMembership;
  /** Inyección para pruebas; por defecto `isAuthorizedPanelUser`. */
  isPanelUser?: (userId: number) => Promise<boolean>;
  client?: SupabaseClient;
  now?: () => number;
}

function requeueRefusal(
  reason: SecurityCommandRequeueRefusalReason,
  options: { detail?: string; requiresHumanReview?: boolean } = {},
): SecurityCommandRequeueResult {
  const result: SecurityCommandRequeueResult = { ok: false, reason };
  if (options.detail !== undefined) result.detail = options.detail;
  if (options.requiresHumanReview) result.requiresHumanReview = true;
  return result;
}

/** Fila que devuelve `zeus_requeue_security_command` (PostgREST: array). */
interface RequeueRpcRow {
  outcome: string;
  original_command_id: string | null;
  retry_command_id: string | null;
  original_status: string | null;
  original_result_state: string | null;
  original_execution_started_at: string | null;
  original_attempts: number | null;
  retry_operation_key: string | null;
  detail: string | null;
}

export const SECURITY_COMMAND_REQUEUE_RPC = "zeus_requeue_security_command";

/**
 * Consume de forma atómica una orden stale y crea su reintento.
 *
 * Diseño (auditoría Fase 1–4):
 * 1. **Autorización antes de leer**: operador del panel + permiso concreto en
 *    el grupo (`can_restrict_members` / `can_change_info`).
 * 2. **Lectura acotada por grupo**: `id` + `group_id`; una orden de otro grupo
 *    se comporta como inexistente (aislamiento).
 * 3. **Política pura** (`evaluateSecurityCommandReplayPolicy`): evidencia de
 *    ejecución, ventana temporal de mute, intentos, profundidad y acción. Es lo
 *    que cubren las pruebas unitarias.
 * 4. **RPC transaccional** `zeus_requeue_security_command` (migración 021): es
 *    la autoridad. Bloquea la fila (`for update`), revalida bajo el lock,
 *    neutraliza la original (`result_state='unknown'` + limpiar
 *    token/lease/processing_at), inserta la copia y escribe la auditoría en la
 *    misma transacción. Si la migración no está aplicada se falla cerrado: no
 *    existe una ruta alternativa no atómica.
 *
 * Por qué esto impide la doble ejecución sin tocar CERBERO: su
 * `claim_security_command` sólo reclama `result_state='processing'` con lease
 * vencido y `execution_started_at IS NULL`, y su
 * `mark_command_execution_started` exige token/instancia vigentes. Como ambas
 * rutas hacen `UPDATE` sobre la misma fila, se serializan con nuestro
 * `FOR UPDATE`: o su marca de inicio gana (y entonces vemos
 * `execution_started_at` y rechazamos), o nuestra neutralización gana (y su
 * marca afecta 0 filas, por lo que CERBERO no ejecuta). La garantía real la
 * valida `tests/security-command-requeue-postgres.test.ts` contra PostgreSQL.
 */
export async function requeueSecurityCommand(
  commandId: string,
  options: SecurityCommandRequeueOptions,
): Promise<SecurityCommandRequeueResult> {
  const id = commandId?.trim();
  const groupId = options?.groupId;
  const actorId = options?.actorId;
  const reason = options?.reason?.trim();

  if (
    !isSecurityCommandId(id) ||
    !Number.isSafeInteger(groupId) ||
    Number(groupId) === 0 ||
    !Number.isSafeInteger(actorId) ||
    Number(actorId) <= 0
  ) {
    return requeueRefusal("invalid_request");
  }
  if (!reason) {
    return requeueRefusal("invalid_request", { detail: "reason_required" });
  }

  const isPanelUser = options.isPanelUser ?? isAuthorizedPanelUser;
  let panelUser = false;
  try {
    panelUser = await isPanelUser(Number(actorId));
  } catch {
    panelUser = false;
  }
  if (!panelUser) {
    return requeueRefusal("unauthorized_operator");
  }

  const membership = options.groupMembership;
  if (!hasGroupAdministrativeStatus(membership)) {
    return requeueRefusal("unauthorized_group");
  }

  const db = options.client ?? getClient();
  const readClock = options.now ?? Date.now;

  const { data: originalRow, error: readError } = await db
    .from("security_commands")
    .select("*")
    .eq("id", id)
    .eq("group_id", Number(groupId))
    .maybeSingle();
  if (readError) throw readError;
  if (!originalRow) return requeueRefusal("not_found");

  const original = originalRow as SecurityCommandRow;

  if (!hasSecurityCommandAuthority(membership, original.action)) {
    return requeueRefusal("unauthorized_group", { detail: original.action });
  }

  const acknowledged = options.acknowledgeLaterHumanDecisions === true;
  const policy = evaluateSecurityCommandReplayPolicy({
    action: original.action,
    payload: original.payload,
    status: original.status,
    resultState: original.result_state,
    executionStartedAt: original.execution_started_at ?? null,
    leaseExpiresAt: original.lease_expires_at,
    processingAt: original.processing_at,
    attempts: original.attempts,
    operationKey: original.operation_key,
    acknowledged,
    now: readClock(),
  });

  if (!policy.allowed) {
    return requeueRefusal(policy.reason ?? "not_retryable", {
      ...(policy.detail !== undefined ? { detail: policy.detail } : {}),
      requiresHumanReview: policy.requiresHumanReview,
    });
  }

  const { data: rpcData, error: rpcError } = await db.rpc(
    SECURITY_COMMAND_REQUEUE_RPC,
    {
      p_command_id: id,
      p_group_id: Number(groupId),
      p_actor_id: Number(actorId),
      p_reason: reason,
      p_acknowledged: acknowledged,
    },
  );

  if (rpcError) {
    const code = rpcError.code ?? "";
    if (code === "23505") {
      // Violación de unicidad (E5). La RPC puede devolverla por dos motivos muy
      // distintos y sólo uno autoriza a hablar de "ya reintentada":
      //   a) colisión del índice de idempotencia `security_commands_operation_key_idx`
      //      (dos operadores a la vez): existe una orden `<clave>#retry` ganadora;
      //   b) cualquier otra restricción única (o una colisión sin ganador
      //      verificable, p. ej. porque la fila cambió de grupo o de acción).
      // El código de error de PostgreSQL no distingue ambos casos por sí solo, así
      // que la clasificación se hace por evidencia: sin fila ganadora NO se
      // informa `already_retried` (eso afirmaría un reintento que no existe y
      // ocultaría que la orden pudo quedar neutralizada). Se degrada a
      // `unexpected_rpc_outcome` con revisión humana.
      const retryKey = `${original.operation_key?.trim() ?? ""}${SECURITY_COMMAND_RETRY_SUFFIX}`;
      const { data: existing, error: lookupError } = await db
        .from("security_commands")
        .select("id")
        .eq("group_id", Number(groupId))
        .eq("action", original.action)
        .eq("operation_key", retryKey)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (existing?.id) {
        return requeueRefusal("already_retried", {
          detail: String(existing.id),
        });
      }
      console.error(
        "[ZEUS] requeueSecurityCommand: violación de unicidad sin reintento ganador " +
          "verificable. No se afirma `already_retried`; la orden requiere revisión humana.",
      );
      return requeueRefusal("unexpected_rpc_outcome", {
        detail: "unique_violation_without_winner",
        requiresHumanReview: true,
      });
    }
    if (code === "PGRST202" || code === "42883") {
      // Migración 021 no aplicada: se falla cerrado, nunca con una ruta no
      // atómica. No se escribe ni se reintenta nada.
      console.error(
        "[ZEUS] requeueSecurityCommand: la RPC atómica no está disponible. " +
          "Aplicar supabase/migrations/021_zeus_security_command_requeue.sql.",
      );
      return requeueRefusal("requeue_rpc_unavailable");
    }
    throw rpcError;
  }

  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
    | RequeueRpcRow
    | undefined;
  if (!row?.outcome) {
    throw new Error("Supabase no devolvió el resultado del reintento.");
  }

  if (row.outcome === "requeued") {
    if (!row.retry_command_id) {
      throw new Error("La RPC no devolvió el ID de la orden reintentada.");
    }
    return {
      ok: true,
      commandId: String(row.retry_command_id),
      retriedFrom: id,
    };
  }

  // `execution_outcome_unknown` es un valor histórico: la política TS ya no lo
  // emite (C9 lo unificó en `confirmation_required`) y la RPC 021 nunca lo
  // devuelve. Se mantiene como rechazo con revisión humana por compatibilidad
  // con una RPC anterior; retirarlo cambiaría el significado de un valor que
  // esta capa no controla.
  if (!isSecurityCommandRequeueRefusalReason(row.outcome)) {
    // Hallazgo B3: un `outcome` desconocido (RPC más nueva, error de despliegue)
    // NO se convierte en miembro del conjunto cerrado por medio de un cast. Se
    // trata como rechazo con revisión humana: nunca como éxito.
    console.error(
      "[ZEUS] requeueSecurityCommand: la RPC devolvió un outcome no reconocido. " +
        "La orden no se considera reintentada.",
    );
    return requeueRefusal("unexpected_rpc_outcome", {
      ...(row.detail ? { detail: String(row.detail) } : {}),
      requiresHumanReview: true,
    });
  }

  const requiresHumanReview =
    row.outcome === "execution_may_have_started" ||
    row.outcome === "unsupported_result_state" ||
    row.outcome === "attempts_exhausted" ||
    row.outcome === "retry_limit_reached" ||
    row.outcome === "execution_outcome_unknown";

  return requeueRefusal(row.outcome, {
    ...(row.detail ? { detail: String(row.detail) } : {}),
    requiresHumanReview,
  });
}
