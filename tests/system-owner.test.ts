import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bootstrapSystemOwner,
  consumeRecoveryKey,
  hashRecoveryKey,
  recoverSystemOwner,
  verifyRecoveryKey,
} from "../src/services/system-owner.js";

const migrationPath = resolve(
  process.cwd(),
  "supabase",
  "migrations",
  "008_system_owner_activation.sql",
);

test("recovery keys are scrypt-hashed with a random salt", async () => {
  const stored = await hashRecoveryKey("unit-test-recovery-key");
  const second = await hashRecoveryKey("unit-test-recovery-key");
  assert.notEqual(stored.hash, "unit-test-recovery-key");
  assert.notEqual(stored.salt, second.salt);
  assert.equal(await verifyRecoveryKey("unit-test-recovery-key", stored), true);
  assert.equal(await verifyRecoveryKey("wrong-key", stored), false);
});

test("recovery rejects invalid input before database access", async () => {
  assert.equal(await consumeRecoveryKey("", 123), false);
  assert.equal(await consumeRecoveryKey("key", 0), false);
  assert.equal(await consumeRecoveryKey("key", -1), false);
});

test("recovery requires private Telegram identity validation", async () => {
  let called = false;
  const recovered = await consumeRecoveryKey("key", 123, async () => {
    called = true;
    return false;
  });
  assert.equal(recovered, false);
  assert.equal(called, true);
});

test("legacy recovery entry point remains explicitly disabled", () => {
  assert.throws(() => recoverSystemOwner(), /Recovery no disponible/);
});

test("bootstrap requires a valid positive user id before RPC access", async () => {
  assert.equal(await bootstrapSystemOwner(0), false);
  assert.equal(await bootstrapSystemOwner(-10), false);
});

test("migration contains atomic bootstrap and one-time challenge recovery", () => {
  const migration = readFileSync(migrationPath, "utf8");
  assert.match(migration, /zeus_bootstrap_system_owner/);
  assert.match(migration, /on conflict \(singleton\) do nothing/);
  assert.match(migration, /SYSTEM_OWNER_BOOTSTRAPPED/);
  assert.match(migration, /system_owner_recovery_challenges/);
  assert.match(migration, /zeus_begin_recovery/);
  assert.match(migration, /zeus_recover_system_owner/);
  assert.match(migration, /challenge_hash = encode\(digest\(p_challenge, 'sha256'\)/);
  assert.match(migration, /FOR UPDATE/i);
  assert.match(migration, /used_at is null/);
  assert.match(migration, /revoked_at is null/);
  assert.match(migration, /set used_at = now\(\)/);
  assert.match(migration, /set consumed_at = now\(\)/);
  assert.match(migration, /zeus_cleanup_recovery_challenges/);
  assert.match(migration, /c\.expires_at <= now\(\)/);
  assert.match(migration, /k\.revoked_at is not null/);
  assert.match(migration, /zeus_generate_recovery_key/);
  assert.match(migration, /RECOVERY_GENERATED/);
  assert.match(migration, /invalidated_at/);
  assert.match(migration, /zeus_record_recovery_rejection/);
  assert.match(migration, /zeus_record_transaction_failure/);
});

test("migration has no activation-key or trusted identity bypass", () => {
  const migration = readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(migration, /system_owner_activation_keys/);
  assert.doesNotMatch(migration, /system_owner_activation_attempts/);
  assert.doesNotMatch(migration, /zeus_rotate_activation_key/);
  assert.doesNotMatch(migration, /p_identity_valid/);
  assert.doesNotMatch(migration, /key_proof_hash/);
  assert.match(migration, /auth\.role\(\)[\s\S]*service_role/);
  assert.match(migration, /revoke execute on function public\.zeus_recover_system_owner/);
  assert.match(migration, /grant execute on function public\.zeus_recover_system_owner[\s\S]*to service_role/);
});

test("Zeus group and recovery flows remain separated", () => {
  const menu = readFileSync(resolve(process.cwd(), "src", "commands", "menu.ts"), "utf8");
  const panel = readFileSync(resolve(process.cwd(), "src", "utils", "private-panel.ts"), "utf8");
  const systemOwner = readFileSync(resolve(process.cwd(), "src", "services", "system-owner.ts"), "utf8");
  assert.doesNotMatch(menu, /isSystemActivated|isGroupActivated|activar.*clave/i);
  assert.doesNotMatch(panel, /isSystemActivated|isGroupActivated|\/activar/);
  assert.doesNotMatch(systemOwner, /BOT_ACTIVATION_KEY|activateSystem|ensureActivationKey|rotateActivationKey|ActivationBackoff/);
});

test("help stays minimal and recovery button uses the real recovery flow", () => {
  const panels = readFileSync(resolve(process.cwd(), "src", "menus", "panels.ts"), "utf8");
  const navigation = readFileSync(resolve(process.cwd(), "src", "menus", "index.ts"), "utf8");
  assert.match(panels, /🚨 Emergencias/);
  assert.match(panels, /🔐 Recovery Key/);
  assert.match(panels, /🔐 Recuperar System Owner/);
  assert.match(panels, /\/borrar/);
  assert.match(panels, /\/mute, \/unmute, \/ban, \/unban y \/kick no están implementados/);
  assert.match(panels, /if \(id === "ayuda"\)/);
  assert.match(navigation, /pendingAction = \{ kind: "recoveryKey" \}/);
});

test("recovery integrates rate limiting, failure clearing, and rejection audit", () => {
  const systemOwner = readFileSync(resolve(process.cwd(), "src", "services", "system-owner.ts"), "utf8");
  const migration = readFileSync(migrationPath, "utf8");
  assert.match(systemOwner, /zeus_recovery_rate_limit_allowed/);
  assert.match(systemOwner, /zeus_clear_recovery_failures/);
  assert.match(systemOwner, /zeus_record_recovery_failure/);
  assert.match(systemOwner, /zeus_record_recovery_rejection/);
  assert.match(migration, /RECOVERY_REJECTED/);
  assert.match(migration, /TRANSACTION_FAILED/);
  assert.match(migration, /set invalidated_at = now\(\)/);
});
