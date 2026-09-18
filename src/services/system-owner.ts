import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function deriveKey(key: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(key, salt, length, SCRYPT_OPTIONS, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export interface KeyHash {
  salt: string;
  hash: string;
}

export async function hashRecoveryKey(key: string, salt = randomBytes(16)): Promise<KeyHash> {
  if (!key) throw new Error("La clave no puede estar vacía.");
  const derived = await deriveKey(key, salt, KEY_LENGTH);
  return { salt: salt.toString("base64"), hash: derived.toString("base64") };
}

export async function verifyRecoveryKey(key: string, stored: KeyHash): Promise<boolean> {
  try {
    const expected = Buffer.from(stored.hash, "base64");
    const actual = await deriveKey(key, Buffer.from(stored.salt, "base64"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function getClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Falta la configuración de Supabase.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function recordAudit(
  db: SupabaseClient,
  eventType: string,
  actorUserId: number,
  targetUserId?: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from("system_owner_audit").insert({
    event_type: eventType,
    actor_user_id: actorUserId,
    target_user_id: targetUserId ?? null,
    metadata: metadata ?? {},
  });
  if (error) throw error;
}

export async function isSystemOwner(userId: number): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const { data, error } = await getClient().from("system_owner")
    .select("owner_user_id").eq("singleton", true).maybeSingle();
  if (error) throw error;
  return data?.owner_user_id === userId;
}

export async function bootstrapSystemOwner(userId: number): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const { data, error } = await getClient().rpc("zeus_bootstrap_system_owner", {
    p_owner_user_id: userId,
  });
  if (error) throw error;
  return data === true;
}

export async function generateRecoveryKey(actorUserId: number): Promise<string> {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new Error("No autorizado.");
  }
  const db = getClient();
  const plaintext = randomBytes(32).toString("base64url");
  const stored = await hashRecoveryKey(plaintext);
  const { data: owner, error: ownerError } = await db.from("system_owner")
    .select("owner_user_id").eq("singleton", true).maybeSingle();
  if (ownerError) throw ownerError;
  if (!owner || owner.owner_user_id !== actorUserId) throw new Error("No autorizado.");
  const { data: inserted, error } = await db.rpc("zeus_generate_recovery_key", {
    p_actor_user_id: actorUserId,
    p_key_salt: stored.salt,
    p_key_hash: stored.hash,
  });
  if (error) throw error;
  if (typeof inserted !== "string" || !inserted) {
    throw new Error("No autorizado.");
  }
  return plaintext;
}

export async function consumeRecoveryKey(
  candidate: string,
  newOwnerId: number,
  verifyTelegramIdentity?: () => Promise<boolean>,
): Promise<boolean> {
  if (!candidate || !Number.isSafeInteger(newOwnerId) || newOwnerId <= 0) {
    return false;
  }
  if (!verifyTelegramIdentity || !(await verifyTelegramIdentity())) return false;
  const db = getClient();
  const { data: allowed, error: rateLimitError } = await db.rpc(
    "zeus_recovery_rate_limit_allowed",
    { p_user_id: newOwnerId },
  );
  if (rateLimitError) throw rateLimitError;
  if (allowed !== true) {
    const audit = await db.rpc("zeus_record_recovery_rejection", {
      p_actor_user_id: newOwnerId,
      p_key_id: null,
      p_reason: "rate_limited",
    });
    if (audit.error) throw audit.error;
    return false;
  }
  // The Recovery Key is verified with scrypt in Zeus. service_role is restricted
  // to this trusted backend, so recovery RPCs receive only an ephemeral challenge.
  const { data, error } = await db.from("system_owner_recovery_keys")
    .select("id,key_salt,key_hash,used_at,revoked_at");
  if (error) throw error;
  for (const row of data ?? []) {
    if (!(await verifyRecoveryKey(candidate, { salt: row.key_salt, hash: row.key_hash }))) continue;
    const { data: challenge, error: challengeError } = await db.rpc("zeus_begin_recovery", {
      p_key_id: row.id,
    });
    if (challengeError) throw challengeError;
    if (typeof challenge !== "string" || !challenge) continue;
    const { data: recovered, error: recoveryError } = await db.rpc("zeus_recover_system_owner", {
      p_key_id: row.id,
      p_challenge: challenge,
      p_new_owner_id: newOwnerId,
      p_actor_user_id: newOwnerId,
    });
    if (recoveryError) {
      const auditFailure = await db.rpc("zeus_record_transaction_failure", {
        p_actor_user_id: newOwnerId,
        p_key_id: row.id,
        p_reason: "recovery_rpc_error",
      });
      if (auditFailure.error) throw auditFailure.error;
      throw recoveryError;
    }
    if (recovered !== true) {
      await db.rpc("zeus_record_recovery_rejection", {
        p_actor_user_id: newOwnerId,
        p_key_id: row.id,
        p_reason: "recovery_rejected",
      });
      await db.rpc("zeus_record_recovery_failure", { p_user_id: newOwnerId });
      return false;
    }
    const cleared = await db.rpc("zeus_clear_recovery_failures", {
      p_user_id: newOwnerId,
    });
    if (cleared.error) throw cleared.error;
    return recovered === true;
  }
  await recordAudit(db, "RECOVERY_REJECTED", newOwnerId, undefined, {
    action: "recovery",
    reason: "invalid_or_unavailable_key",
  });
  const recorded = await db.rpc("zeus_record_recovery_failure", { p_user_id: newOwnerId });
  if (recorded.error) throw recorded.error;
  return false;
}

export async function revokeRecoveryKey(id: string, actorUserId: number): Promise<void> {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new Error("No autorizado.");
  }
  const db = getClient();
  const { data: owner, error: ownerError } = await db.from("system_owner")
    .select("owner_user_id").eq("singleton", true).maybeSingle();
  if (ownerError) throw ownerError;
  if (!owner || owner.owner_user_id !== actorUserId) throw new Error("No autorizado.");
  const { data: key, error: lookupError } = await db.from("system_owner_recovery_keys")
    .select("id").eq("id", id).is("used_at", null).maybeSingle();
  if (lookupError) throw lookupError;
  if (!key) throw new Error("Recovery Key no encontrada.");
  const { error } = await db.from("system_owner_recovery_keys")
    .update({ revoked_at: new Date().toISOString() }).eq("id", id).is("used_at", null);
  if (error) throw error;
  await recordAudit(db, "RECOVERY_REVOKED", actorUserId, undefined, { recovery_key_id: id });
}

export async function cleanupRecoveryChallenges(): Promise<number> {
  const { data, error } = await getClient().rpc("zeus_cleanup_recovery_challenges");
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/** Compatibilidad con integraciones antiguas: el consumo real usa consumeRecoveryKey. */
export function recoverSystemOwner(): never {
  throw new Error("Recovery no disponible: usa consumeRecoveryKey con una clave entregada fuera de banda.");
}
