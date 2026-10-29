import type { ChatMember } from "@grammyjs/types";
import { isConfiguredAdminId } from "../config.js";
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
  isDeleted: boolean;
}

const ACTIVITY_TABLE = "security_user_activity";
const REQUEST_TIMEOUT_MS = 8_000;
let warnedMissingConfiguration = false;

function activityConfig(): UserActivityConfig {
  return {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

function activityEndpoint(config: UserActivityConfig): URL {
  if (!config.url || !config.key) {
    throw new Error("ZEUS_USER_ACTIVITY_SUPABASE_NOT_CONFIGURED");
  }
  return new URL(`/rest/v1/${ACTIVITY_TABLE}`, config.url);
}

function activityHeaders(
  config: UserActivityConfig,
  extra?: Record<string, string>,
): HeadersInit {
  if (!config.key) throw new Error("ZEUS_USER_ACTIVITY_SUPABASE_NOT_CONFIGURED");
  return {
    apikey: config.key,
    authorization: `Bearer ${config.key}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function request(
  url: URL,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function throwIfHttpError(response: Response): void {
  if (!response.ok) {
    throw new Error(`ZEUS_USER_ACTIVITY_HTTP_${response.status}`);
  }
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
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
  options: {
    isDeleted?: boolean;
    config?: UserActivityConfig;
    fetcher?: typeof fetch;
  } = {},
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
  const config = options.config ?? activityConfig();
  const endpoint = activityEndpoint(config);
  endpoint.searchParams.set("on_conflict", "group_id,user_id");
  const response = await request(
    endpoint,
    {
      method: "POST",
      headers: activityHeaders(config, {
        prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        last_active_at: lastActiveAt,
        ...(options.isDeleted ? { is_deleted: true } : {}),
      }),
    },
    options.fetcher ?? fetch,
  );
  throwIfHttpError(response);
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

export async function markTelegramAccountDeleted(
  groupId: number,
  userId: number,
  now = Date.now(),
): Promise<void> {
  await upsertUserActivity(groupId, userId, new Date(now).toISOString(), {
    isDeleted: true,
  });
}

export async function getInactiveActivityCandidates(
  groupId: number,
  cutoff: string,
  options: {
    limit?: number;
    config?: UserActivityConfig;
    fetcher?: typeof fetch;
  } = {},
): Promise<UserActivityCandidate[]> {
  if (!Number.isSafeInteger(groupId) || groupId === 0 || !validTimestamp(cutoff)) {
    throw new Error("ZEUS_USER_ACTIVITY_QUERY_INVALID");
  }
  const config = options.config ?? activityConfig();
  const endpoint = activityEndpoint(config);
  endpoint.searchParams.set(
    "select",
    "group_id,user_id,last_active_at,is_deleted",
  );
  endpoint.searchParams.set("group_id", `eq.${groupId}`);
  endpoint.searchParams.set(
    "or",
    `(last_active_at.lt.${cutoff},is_deleted.eq.true)`,
  );
  endpoint.searchParams.set("order", "last_active_at.asc");
  endpoint.searchParams.set(
    "limit",
    String(Math.min(200, Math.max(1, Math.floor(options.limit ?? 100)))),
  );

  const response = await request(
    endpoint,
    {
      method: "GET",
      headers: activityHeaders(config, { accept: "application/json" }),
    },
    options.fetcher ?? fetch,
  );
  throwIfHttpError(response);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("ZEUS_USER_ACTIVITY_RESPONSE_INVALID");
  }
  const candidates: UserActivityCandidate[] = [];
  for (const row of payload) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("group_id" in row) ||
      !("user_id" in row) ||
      !("last_active_at" in row) ||
      !("is_deleted" in row)
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
      !validTimestamp(value.last_active_at) ||
      typeof value.is_deleted !== "boolean"
    ) {
      throw new Error("ZEUS_USER_ACTIVITY_RESPONSE_INVALID");
    }
    candidates.push({
      groupId,
      userId: value.user_id,
      lastActiveAt: value.last_active_at,
      isDeleted: value.is_deleted,
    });
  }
  return candidates;
}

export function warnMissingActivityConfiguration(): void {
  if (warnedMissingConfiguration) return;
  console.warn(
    "[ZEUS] Supabase no está configurado; se omitirá la depuración de actividad.",
  );
  warnedMissingConfiguration = true;
}
