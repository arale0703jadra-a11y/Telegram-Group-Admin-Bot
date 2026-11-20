import type { ChatMember } from "@grammyjs/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isConfiguredAdminId } from "../config.js";
import {
  getInternalSupabaseClient,
  isSupabaseConfigured,
} from "../supabase.js";
import {
  getMemberSafely,
  isProtectedMember,
  isVerifiableMember,
} from "../moderation/actions.js";
import { isVerifiedUser } from "./verified-users.js";
import type { MyContext } from "../types.js";

export interface UserActivityRecord {
  group_id: number;
  user_id: number;
  last_active_at: string;
  is_deleted: boolean;
}

export interface UserActivityConfig {
  url?: string;
  key?: string;
}

export interface UserActivityCandidate {
  groupId: number;
  userId: number;
  lastActiveAt: string;
}

const REQUEST_TIMEOUT_MS = 8_000;
let warnedMissingConfiguration = false;
let warnedMissingActivityRpc = false;

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

export interface UserActivityRequestOptions {
  /** Legacy REST fallback credentials. Defaults to the environment. */
  config?: UserActivityConfig;
  /** Injectable fetch used by the legacy REST fallback (tests/offline). */
  fetcher?: typeof fetch;
  /** Injectable Supabase client (RPC path). Defaults to the internal one. */
  client?: SupabaseClient;
}

/**
 * PostgREST reports a missing function with PGRST202 (schema cache miss) or
 * PostgreSQL 42883 (undefined_function).
 *
 * The RPC-first path is the least-privilege design, but ZEUS must keep working
 * while migration 020 is not applied remotely, so an absent RPC falls back to
 * the previous table-level path instead of failing every activity write.
 */
function isMissingRpc(error: PostgrestLikeError | null): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const message = error.message ?? "";
  return (
    code === "PGRST202" ||
    code === "42883" ||
    /could not find the function|function .* does not exist/iu.test(message)
  );
}

function warnMissingActivityRpc(): void {
  if (warnedMissingActivityRpc) return;
  warnedMissingActivityRpc = true;
  console.warn(
    "[ZEUS] La función zeus_upsert_user_activity no está desplegada; " +
      "se usa la ruta compatible sobre security_user_activity. " +
      "Aplica la migración 020 para operar con permisos mínimos.",
  );
}

function resolveRequestTarget(options: UserActivityRequestOptions):
  | { url: string; key: string; fetcher: typeof fetch }
  | undefined {
  const url = options.config?.url ?? process.env.SUPABASE_URL;
  const key = options.config?.key ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return undefined;
  return {
    url: url.replace(/\/+$/u, ""),
    key,
    fetcher: options.fetcher ?? fetch,
  };
}

function authorizationHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
  };
}

function resolveClient(options: UserActivityRequestOptions):
  | SupabaseClient
  | undefined {
  if (options.client) return options.client;
  return isSupabaseConfigured() ? getInternalSupabaseClient() : undefined;
}

function mapActivityCandidates(
  groupId: number,
  data: unknown,
): UserActivityCandidate[] {
  if (!Array.isArray(data)) return [];
  const candidates: UserActivityCandidate[] = [];
  for (const row of data) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("group_id" in row) ||
      !("user_id" in row) ||
      !("last_active_at" in row)
    ) {
      throw new Error("ZEUS_USER_ACTIVITY_RESPONSE_INVALID");
    }
    const value = row as Record<string, unknown>;
    if (
      value.group_id !== groupId ||
      typeof value.user_id !== "number" ||
      !Number.isSafeInteger(value.user_id) ||
      value.user_id <= 0 ||
      typeof value.last_active_at !== "string" ||
      !validTimestamp(value.last_active_at)
    ) {
      throw new Error("ZEUS_USER_ACTIVITY_RESPONSE_INVALID");
    }
    candidates.push({
      groupId,
      userId: value.user_id,
      lastActiveAt: value.last_active_at,
    });
  }
  return candidates;
}

export function shouldTrackUserActivity(
  member: ChatMember | undefined,
  userId: number,
  isVerified: boolean,
): boolean {
  return Boolean(
    member &&
      !member.user.is_bot &&
      isVerifiableMember(member) &&
      !isProtectedMember(member) &&
      !isConfiguredAdminId(userId) &&
      !isVerified,
  );
}

export async function upsertUserActivity(
  groupId: number,
  userId: number,
  lastActiveAt: string,
  options: UserActivityRequestOptions = {},
): Promise<void> {
  if (
    !Number.isSafeInteger(groupId) ||
    groupId === 0 ||
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !validTimestamp(lastActiveAt)
  ) {
    throw new Error("ZEUS_USER_ACTIVITY_INPUT_INVALID");
  }

  const client = resolveClient(options);
  if (client) {
    const { error } = await client.rpc("zeus_upsert_user_activity", {
      p_group_id: groupId,
      p_user_id: userId,
      p_last_active_at: lastActiveAt,
    });
    if (!error) return;
    if (!isMissingRpc(error)) throw error;
    warnMissingActivityRpc();
  }

  const target = resolveRequestTarget(options);
  if (!target) throw new Error("ZEUS_USER_ACTIVITY_NOT_CONFIGURED");
  const response = await target.fetcher(
    `${target.url}/rest/v1/security_user_activity?on_conflict=group_id%2Cuser_id`,
    {
      method: "POST",
      headers: {
        ...authorizationHeaders(target.key),
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        last_active_at: lastActiveAt,
        is_deleted: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `No se pudo registrar la actividad del usuario (HTTP ${response.status}).`,
    );
  }
}


export async function recordUserActivity(
  ctx: MyContext,
  groupId: number,
  userId: number,
  timestampSeconds: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new Error("ZEUS_USER_ACTIVITY_TIMESTAMP_INVALID");
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (!warnedMissingConfiguration) {
      console.warn(
        "[ZEUS] Supabase no está configurado; no se guardará actividad de usuarios.",
      );
      warnedMissingConfiguration = true;
    }
    return false;
  }

  const member = await getMemberSafely(ctx, groupId, userId);
  if (!member) return false;
  const verified = await isVerifiedUser(groupId, userId);
  if (!shouldTrackUserActivity(member, userId, verified)) return false;

  await upsertUserActivity(groupId, userId, new Date(timestampSeconds * 1000).toISOString());
  return true;
}

export async function getInactiveActivityCandidates(
  groupId: number,
  cutoff: string,
  options: UserActivityRequestOptions & { limit?: number } = {},
): Promise<UserActivityCandidate[]> {
  if (!Number.isSafeInteger(groupId) || groupId === 0 || !validTimestamp(cutoff)) {
    throw new Error("ZEUS_USER_ACTIVITY_QUERY_INVALID");
  }
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100)));

  const client = resolveClient(options);
  if (client) {
    const { data, error } = await client.rpc(
      "zeus_get_inactive_activity_candidates",
      {
        p_group_id: groupId,
        p_cutoff: cutoff,
        p_limit: limit,
      },
    );
    if (!error) return mapActivityCandidates(groupId, data);
    if (!isMissingRpc(error)) throw error;
    warnMissingActivityRpc();
  }

  const target = resolveRequestTarget(options);
  if (!target) throw new Error("ZEUS_USER_ACTIVITY_NOT_CONFIGURED");
  const query = new URLSearchParams({
    select: "group_id,user_id,last_active_at",
    group_id: `eq.${groupId}`,
    last_active_at: `lt.${cutoff}`,
    is_deleted: "eq.false",
    order: "last_active_at.asc",
    limit: String(limit),
  });
  const response = await target.fetcher(
    `${target.url}/rest/v1/security_user_activity?${query.toString()}`,
    {
      headers: authorizationHeaders(target.key),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `No se pudo consultar la actividad de usuarios (HTTP ${response.status}).`,
    );
  }
  return mapActivityCandidates(groupId, await response.json());
}

export function warnMissingActivityConfiguration(): void {
  if (warnedMissingConfiguration) return;
  console.warn(
    "[ZEUS] Supabase no está configurado; se omitirá la depuración de actividad.",
  );
  warnedMissingConfiguration = true;
}
