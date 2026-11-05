import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { StorageAdapter } from "grammy";
import type {
  PendingAction,
  PickAction,
  UserPanelState,
  VerifiedConfirmationOperation,
} from "../types.js";

export const USER_SESSION_TIMEOUT_MS = 5_000;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const PENDING_ACTION_TTL_MS = 15 * 60 * 1_000;
const CONFIRMATION_AAD = Buffer.from("ZEUS user-session confirmation v1");
const SESSION_KEY_PATTERN = /^user:([1-9]\d{0,15})$/u;
const SESSION_SNAPSHOT = Symbol("user-session-snapshot");
const PICK_ACTIONS = new Set<PickAction>([
  "search",
  "warn",
  "mute",
  "unmute",
  "ban",
]);
const CONFIRMATION_OPERATIONS = new Set<VerifiedConfirmationOperation>([
  "activate",
  "reactivate",
  "revoke",
  "candidate-approve",
  "candidate-reject",
]);

type SessionOperation = "read" | "write" | "delete";
type SessionFailureReason =
  | "not_configured"
  | "timeout"
  | "conflict"
  | "invalid_data"
  | "unavailable";

export class UserSessionPersistenceError extends Error {
  constructor(
    readonly operation: SessionOperation,
    readonly reason: SessionFailureReason,
    readonly databaseCode?: string,
  ) {
    super(`No se pudo persistir la sesión (${operation}: ${reason}).`);
    this.name = "UserSessionPersistenceError";
  }
}

interface SessionRow {
  payload: unknown;
  version: unknown;
  expires_at: unknown;
  pending_action_expires_at: unknown;
}

interface SessionWriteRow {
  version: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionUserId(
  key: string,
  operation: SessionOperation = "read",
): number {
  const match = SESSION_KEY_PATTERN.exec(key);
  const userId = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new UserSessionPersistenceError(operation, "invalid_data");
  }
  return userId;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0;
}

function validGroupId(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value !== 0;
}

function validOptionalMessageId(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function validPendingAction(value: unknown): value is PendingAction {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "recoveryKey") return true;
  if (!validGroupId(value.groupId)) return false;

  switch (value.kind) {
    case "search":
    case "filterAdd":
    case "illegalAdd":
    case "unbanId":
    case "verifiedMarkers":
    case "verifiedSearch":
    case "verifiedManualAdd":
    case "promotionTest":
    case "automaticMessage":
      return validOptionalMessageId(value.messageId);
    case "illegalDelete":
    case "filterDelete":
      return Number.isSafeInteger(value.index) &&
        Number(value.index) >= 0 &&
        Number.isSafeInteger(value.page) &&
        Number(value.page) >= 0 &&
        validOptionalMessageId(value.messageId);
    case "pick":
      return typeof value.action === "string" &&
        PICK_ACTIONS.has(value.action as PickAction) &&
        validOptionalMessageId(value.messageId);
    case "muteMinutes":
    case "warnReason":
    case "banReason":
      return positiveInteger(value.userId) &&
        validOptionalMessageId(value.messageId);
    case "muteReason":
      return positiveInteger(value.userId) &&
        Number.isSafeInteger(value.minutes) &&
        Number(value.minutes) > 0 &&
        Number(value.minutes) <= 527_040 &&
        validOptionalMessageId(value.messageId);
    default:
      return false;
  }
}

function sanitizePendingAction(action: PendingAction): PendingAction {
  switch (action.kind) {
    case "recoveryKey":
      return { kind: action.kind };
    case "search":
    case "filterAdd":
    case "illegalAdd":
    case "unbanId":
      return {
        kind: action.kind,
        groupId: action.groupId,
        ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
      };
    case "illegalDelete":
    case "filterDelete":
      return {
        kind: action.kind,
        groupId: action.groupId,
        index: action.index,
        page: action.page,
        ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
      };
    case "pick":
      return {
        kind: action.kind,
        action: action.action,
        groupId: action.groupId,
        ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
      };
    case "muteMinutes":
    case "warnReason":
    case "banReason":
      return {
        kind: action.kind,
        userId: action.userId,
        groupId: action.groupId,
        ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
      };
    case "muteReason":
      return {
        kind: action.kind,
        userId: action.userId,
        groupId: action.groupId,
        minutes: action.minutes,
        ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
      };
    case "promotionTest":
    case "automaticMessage":
    case "verifiedMarkers":
    case "verifiedSearch":
    case "verifiedManualAdd":
      return { kind: action.kind, groupId: action.groupId };
  }
}

function snapshotUserSessionState(state: UserPanelState): string {
  return JSON.stringify({
    selectedGroupId: state.selectedGroupId,
    selectedGroupTitle: state.selectedGroupTitle,
    selectedVerifiedSearch: state.selectedVerifiedSearch,
    pendingAction: state.pendingAction,
    verifiedConfirmation: state.verifiedConfirmation,
  });
}

function getEncryptionKey(): Buffer {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new UserSessionPersistenceError("write", "not_configured");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(serviceRoleKey),
      Buffer.from("ZEUS user-session encryption v1"),
      Buffer.from("verified-confirmation-token"),
      32,
    ),
  );
}

function encryptConfirmationToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  cipher.setAAD(CONFIRMATION_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    "enc",
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function decryptConfirmationToken(value: string): string {
  const [prefix, version, ivText, tagText, ciphertextText, ...extra] =
    value.split(":");
  if (
    prefix !== "enc" ||
    version !== "v1" ||
    !ivText ||
    !tagText ||
    !ciphertextText ||
    extra.length > 0
  ) {
    throw new Error("Invalid encrypted confirmation token.");
  }
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 256) {
    throw new Error("Invalid encrypted confirmation token.");
  }
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAAD(CONFIRMATION_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function serializeUserSessionState(
  state: UserPanelState,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (validGroupId(state.selectedGroupId)) {
    payload.selectedGroupId = state.selectedGroupId;
  }
  if (typeof state.selectedGroupTitle === "string") {
    payload.selectedGroupTitle = state.selectedGroupTitle.slice(0, 255);
  }
  if (typeof state.selectedVerifiedSearch === "string") {
    payload.selectedVerifiedSearch = state.selectedVerifiedSearch.slice(0, 64);
  }
  if (state.pendingAction !== undefined) {
    if (!validPendingAction(state.pendingAction)) {
      throw new UserSessionPersistenceError("write", "invalid_data");
    }
    payload.pendingAction = sanitizePendingAction(state.pendingAction);
  }
  if (state.verifiedConfirmation !== undefined) {
    const confirmation = state.verifiedConfirmation;
    if (
      !validGroupId(confirmation.groupId) ||
      !positiveInteger(confirmation.userId) ||
      !positiveInteger(confirmation.actorUserId) ||
      !CONFIRMATION_OPERATIONS.has(confirmation.operation) ||
      !/^[a-f0-9]{18}$/iu.test(confirmation.token) ||
      !Number.isSafeInteger(confirmation.expiresAt)
    ) {
      throw new UserSessionPersistenceError("write", "invalid_data");
    }
    payload.verifiedConfirmation = {
      groupId: confirmation.groupId,
      userId: confirmation.userId,
      actorUserId: confirmation.actorUserId,
      operation: confirmation.operation,
      token: encryptConfirmationToken(confirmation.token),
      expiresAt: confirmation.expiresAt,
      ...(typeof confirmation.permissionsSnapshot === "string"
        ? { permissionsSnapshot: confirmation.permissionsSnapshot.slice(0, 32) }
        : {}),
    };
  }
  return payload;
}

/** Claves que la RPC `zeus_write_user_session` acepta en BD (lista blanca). */
const WRITABLE_SESSION_KEYS: ReadonlySet<string> = new Set([
  "selectedGroupId",
  "selectedGroupTitle",
  "selectedVerifiedSearch",
  "pendingAction",
  "verifiedConfirmation",
]);

/** Límite del CHECK `octet_length(payload::text) <= 16384` de la migración 019. */
export const MAX_SESSION_PAYLOAD_BYTES = 16_384;

/**
 * Validación local previa a la RPC: mismas reglas que aplica la base de
 * datos (claves permitidas y tamaño máximo), para clasificar estos casos
 * como `invalid_data` en lugar de consumir una llamada y reportarlos como
 * indisponibilidad. Nunca trunca datos: si algo no cabe, se rechaza la
 * escritura y el estado en memoria queda sin persistir (fail-closed).
 */
export function assertSessionPayloadWritable(
  payload: Record<string, unknown>,
): void {
  for (const key of Object.keys(payload)) {
    if (!WRITABLE_SESSION_KEYS.has(key)) {
      throw new UserSessionPersistenceError("write", "invalid_data");
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new UserSessionPersistenceError("write", "invalid_data");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_PAYLOAD_BYTES) {
    throw new UserSessionPersistenceError("write", "invalid_data");
  }
}

function deserializeUserSessionState(
  value: unknown,
  userId: number,
  version: number,
  pendingActionExpiresAt: unknown,
  now: number,
  warn: (message: string) => void,
): UserPanelState {
  if (!isRecord(value)) {
    throw new UserSessionPersistenceError("read", "invalid_data");
  }
  const state: UserPanelState = { persistenceVersion: version };
  if (validGroupId(value.selectedGroupId)) {
    state.selectedGroupId = value.selectedGroupId;
  }
  if (
    typeof value.selectedGroupTitle === "string" &&
    value.selectedGroupTitle.length <= 255
  ) {
    state.selectedGroupTitle = value.selectedGroupTitle;
  }
  if (
    typeof value.selectedVerifiedSearch === "string" &&
    value.selectedVerifiedSearch.length <= 64
  ) {
    state.selectedVerifiedSearch = value.selectedVerifiedSearch;
  }
  if (value.pendingAction !== undefined) {
    const expiry = typeof pendingActionExpiresAt === "string"
      ? Date.parse(pendingActionExpiresAt)
      : Number.NaN;
    if (
      validPendingAction(value.pendingAction) &&
      Number.isFinite(expiry) &&
      expiry > now
    ) {
      state.pendingAction = sanitizePendingAction(value.pendingAction);
    } else {
      warn("Discarded invalid or expired pending action.");
    }
  }
  if (value.verifiedConfirmation !== undefined) {
    const confirmation = value.verifiedConfirmation;
    if (
      isRecord(confirmation) &&
      validGroupId(confirmation.groupId) &&
      positiveInteger(confirmation.userId) &&
      confirmation.actorUserId === userId &&
      CONFIRMATION_OPERATIONS.has(
        confirmation.operation as VerifiedConfirmationOperation,
      ) &&
      typeof confirmation.token === "string" &&
      Number.isSafeInteger(confirmation.expiresAt) &&
      Number(confirmation.expiresAt) > now
    ) {
      try {
        const token = decryptConfirmationToken(confirmation.token);
        if (!/^[a-f0-9]{18}$/iu.test(token)) {
          throw new Error("Invalid confirmation token.");
        }
        state.verifiedConfirmation = {
          groupId: confirmation.groupId,
          userId: confirmation.userId,
          actorUserId: userId,
          operation: confirmation.operation as VerifiedConfirmationOperation,
          token,
          expiresAt: Number(confirmation.expiresAt),
          ...(typeof confirmation.permissionsSnapshot === "string"
            ? { permissionsSnapshot: confirmation.permissionsSnapshot.slice(0, 32) }
            : {}),
        };
      } catch {
        warn("Discarded an unreadable or invalid confirmation.");
      }
    } else {
      warn("Discarded an invalid or expired confirmation.");
    }
  }
  Object.defineProperty(state, SESSION_SNAPSHOT, {
    configurable: true,
    value: snapshotUserSessionState(state),
  });
  return state;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.code === "string") {
    return error.code.slice(0, 32);
  }
  return undefined;
}

function persistenceError(
  operation: SessionOperation,
  error: unknown,
  timedOut: boolean,
): UserSessionPersistenceError {
  if (error instanceof UserSessionPersistenceError) return error;
  const code = databaseErrorCode(error);
  return new UserSessionPersistenceError(
    operation,
    timedOut
      ? "timeout"
      : code === "40001" || code === "23505"
        ? "conflict"
        : code === "22023"
          ? "invalid_data"
          : "unavailable",
    code,
  );
}

function firstRow<T>(value: unknown): T | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value[0] as T : undefined;
  return isRecord(value) ? value as T : undefined;
}

export class SupabaseUserSessionStorage
implements StorageAdapter<UserPanelState> {
  private cachedClient: SupabaseClient | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly warn: (message: string) => void = (message) =>
      console.warn(`[USER SESSION] ${message}`),
    private readonly clientProvider?: () => SupabaseClient,
    private readonly timeoutMs: number = USER_SESSION_TIMEOUT_MS,
  ) {}

  private getClient(operation: SessionOperation): SupabaseClient {
    if (this.clientProvider) return this.clientProvider();
    if (this.cachedClient) return this.cachedClient;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new UserSessionPersistenceError(operation, "not_configured");
    }
    this.cachedClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return this.cachedClient;
  }

  async read(key: string): Promise<UserPanelState | undefined> {
    const userId = sessionUserId(key, "read");
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const { data, error } = await this.getClient("read")
        .rpc("zeus_read_user_session", { p_session_key: key })
        .abortSignal(signal);
      if (error) throw error;
      const row = firstRow<SessionRow>(data);
      if (!row) return undefined;
      const version = Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new UserSessionPersistenceError("read", "invalid_data");
      }
      const expiresAt = typeof row.expires_at === "string"
        ? Date.parse(row.expires_at)
        : Number.NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
        return undefined;
      }
      return deserializeUserSessionState(
        row.payload,
        userId,
        version,
        row.pending_action_expires_at,
        this.now(),
        this.warn,
      );
    } catch (error) {
      throw persistenceError("read", error, signal.aborted);
    }
  }

  async write(key: string, value: UserPanelState): Promise<void> {
    const userId = sessionUserId(key, "write");
    const expectedVersion = value.persistenceVersion ?? 0;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new UserSessionPersistenceError("write", "invalid_data");
    }
    const payload = serializeUserSessionState(value);
    assertSessionPayloadWritable(payload);
    const snapshot = snapshotUserSessionState(value);
    const priorSnapshot = (value as UserPanelState & {
      [SESSION_SNAPSHOT]?: string;
    })[SESSION_SNAPSHOT];
    if (
      (expectedVersion === 0 && Object.keys(payload).length === 0) ||
      (priorSnapshot !== undefined && priorSnapshot === snapshot)
    ) {
      return;
    }
    if (
      payload.verifiedConfirmation &&
      (payload.verifiedConfirmation as Record<string, unknown>).actorUserId !== userId
    ) {
      throw new UserSessionPersistenceError("write", "invalid_data");
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const { data, error } = await this.getClient("write")
        .rpc("zeus_write_user_session", {
          p_session_key: key,
          p_payload: payload,
          p_expected_version: expectedVersion,
          p_session_ttl_seconds: SESSION_TTL_MS / 1_000,
          p_pending_ttl_seconds: PENDING_ACTION_TTL_MS / 1_000,
        })
        .abortSignal(signal);
      if (error) throw error;
      const row = firstRow<SessionWriteRow>(data);
      const nextVersion = Number(row?.version);
      if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) {
        throw new UserSessionPersistenceError("write", "conflict");
      }
      value.persistenceVersion = nextVersion;
      Object.defineProperty(value, SESSION_SNAPSHOT, {
        configurable: true,
        value: snapshot,
      });
    } catch (error) {
      throw persistenceError("write", error, signal.aborted);
    }
  }

  async delete(key: string): Promise<void> {
    sessionUserId(key, "delete");
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const { error } = await this.getClient("delete")
        .rpc("zeus_delete_user_session", { p_session_key: key })
        .abortSignal(signal);
      if (error) throw error;
    } catch (error) {
      throw persistenceError("delete", error, signal.aborted);
    }
  }
}
