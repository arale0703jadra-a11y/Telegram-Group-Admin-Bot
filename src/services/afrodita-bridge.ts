import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Puente ZEUS ↔ AFRODITA sobre Supabase/PostgreSQL.
 *
 * ZEUS usa SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service_role evita RLS).
 * Lee el estado y el historial que AFRODITA publica, y encola órdenes que
 * AFRODITA aplica de forma asíncrona. No se usan mensajes de Telegram ni
 * archivos JSON compartidos entre bots.
 *
 * Sin credenciales configuradas, `isAfroditaBridgeConfigured()` devuelve
 * false y las operaciones lanzan `AfroditaBridgeUnavailableError` para que
 * el panel muestre un aviso claro en lugar de fallar en silencio.
 */

let cachedClient: SupabaseClient | undefined;

export class AfroditaBridgeUnavailableError extends Error {
  constructor(reason: "not_configured" | "query_failed") {
    super(`AFRODITA_BRIDGE_${reason.toUpperCase()}`);
    this.name = "AfroditaBridgeUnavailableError";
  }
}

export interface AfroditaStateRow {
  chat_id: number;
  state: Record<string, unknown>;
  updated_at: string;
  updated_by: string;
}

export interface AfroditaEventRow {
  id: number;
  chat_id: number;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AfroditaEventFilter {
  chatId?: number;
  kind?: string;
  page?: number;
  pageSize?: number;
}

export interface AfroditaGlobalControlRow {
  id: "global";
  mode: "running" | "paused";
  updated_at: string;
  updated_by: string;
  heartbeat_at: string;
}

export interface AfroditaGlobalCommand {
  id: number;
  command: "pause" | "resume";
  status: "pending" | "applied" | "failed";
  last_error: string | null;
  created_at: string;
  applied_at: string | null;
}

export function isAfroditaBridgeConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new AfroditaBridgeUnavailableError("not_configured");
  }
  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

/** Reinicia la caché del cliente (solo para pruebas). */
export function resetAfroditaBridgeClient(): void {
  cachedClient = undefined;
}

function failIf(error: { message: string } | null): void {
  if (error) {
    console.error(
      `[AFRODITA BRIDGE] Consulta fallida (${error.message.slice(0, 120)}).`,
    );
    throw new AfroditaBridgeUnavailableError("query_failed");
  }
}

/** Instantáneas de estado de todos los grupos con actividad de AFRODITA. */
export async function listAfroditaStates(
  limit = 100,
): Promise<AfroditaStateRow[]> {
  const { data, error } = await getClient()
    .from("afrodita_group_state")
    .select("chat_id,state,updated_at,updated_by")
    .order("updated_at", { ascending: false })
    .limit(limit);
  failIf(error);
  return (data ?? []) as AfroditaStateRow[];
}

/** Instantánea de un grupo concreto; undefined si AFRODITA aún no lo publicó. */
export async function getAfroditaState(
  chatId: number,
): Promise<AfroditaStateRow | undefined> {
  const { data, error } = await getClient()
    .from("afrodita_group_state")
    .select("chat_id,state,updated_at,updated_by")
    .eq("chat_id", chatId)
    .maybeSingle();
  failIf(error);
  return (data ?? undefined) as AfroditaStateRow | undefined;
}

export async function getAfroditaGlobalControl(): Promise<
  AfroditaGlobalControlRow | undefined
> {
  const { data, error } = await getClient()
    .from("afrodita_control_state")
    .select("id,mode,updated_at,updated_by,heartbeat_at")
    .eq("id", "global")
    .maybeSingle();
  failIf(error);
  return (data ?? undefined) as AfroditaGlobalControlRow | undefined;
}

async function findPendingGlobalCommand(): Promise<number | undefined> {
  const { data, error } = await getClient()
    .from("afrodita_commands")
    .select("id")
    .eq("status", "pending")
    .filter("payload->>scope", "eq", "global")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  failIf(error);
  const id = (data as { id?: number } | null)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

export async function getLatestAfroditaGlobalCommand(): Promise<
  AfroditaGlobalCommand | undefined
> {
  const { data, error } = await getClient()
    .from("afrodita_commands")
    .select("id,command,status,last_error,created_at,applied_at")
    .filter("payload->>scope", "eq", "global")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  failIf(error);
  return (data ?? undefined) as AfroditaGlobalCommand | undefined;
}

export async function enqueueAfroditaGlobalCommand(
  command: "pause" | "resume",
  actorUserId: number,
): Promise<{ id?: number; pending: boolean; unchanged: boolean }> {
  const pendingId = await findPendingGlobalCommand();
  if (pendingId !== undefined) {
    return { id: pendingId, pending: true, unchanged: false };
  }
  const current = await getAfroditaGlobalControl();
  const targetMode = command === "pause" ? "paused" : "running";
  if ((current?.mode ?? "paused") === targetMode) {
    return { pending: false, unchanged: true };
  }
  const { data, error } = await getClient()
    .from("afrodita_commands")
    .insert({
      chat_id: 0,
      command,
      payload: { scope: "global" },
      created_by: actorUserId,
    })
    .select("id")
    .single();
  if (error?.code === "23505") {
    const duplicateId = await findPendingGlobalCommand();
    if (duplicateId !== undefined) {
      return { id: duplicateId, pending: true, unchanged: false };
    }
  }
  failIf(error);
  const id = Number((data as { id: number } | null)?.id ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AfroditaBridgeUnavailableError("query_failed");
  }
  return { id, pending: true, unchanged: false };
}

/**
 * Historial de eventos (publicaciones y encuestas) con paginación.
 * Devuelve hasta `pageSize + 1` filas para saber si hay página siguiente.
 */
export async function listAfroditaEvents(
  filter: AfroditaEventFilter = {},
): Promise<AfroditaEventRow[]> {
  const page = Math.max(0, filter.page ?? 0);
  const pageSize = Math.min(50, Math.max(1, filter.pageSize ?? 20));
  let query = getClient()
    .from("afrodita_events")
    .select("id,chat_id,kind,payload,created_at")
    .order("id", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize);
  if (filter.chatId !== undefined) query = query.eq("chat_id", filter.chatId);
  if (filter.kind) query = query.eq("kind", filter.kind);
  const { data, error } = await query;
  failIf(error);
  return (data ?? []) as AfroditaEventRow[];
}
