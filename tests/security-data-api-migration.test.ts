import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relations = [
  "bots",
  "groups",
  "group_bot_bindings",
  "security_commands",
  "security_events",
  "security_audit_log",
  "security_group_configs",
  "security_sanctions",
  "security_protected_users",
  "security_warnings",
  "verified_users",
  "system_owner",
  "system_owner_recovery_keys",
  "system_owner_recovery_attempts",
  "system_owner_recovery_challenges",
  "system_owner_audit",
  "verified_member_tag_reviews",
  "verified_member_tag_audit",
];

test("security data API migration restricts all related tables to service_role", async () => {
  const sql = await readFile(
    resolve(root, "supabase/migrations/012_lock_down_security_data_api.sql"),
    "utf8",
  );
  for (const relation of relations) {
    assert.ok(sql.includes(`'${relation}'`), `missing relation ${relation}`);
  }
  assert.match(sql, /enable row level security/iu);
  assert.match(
    sql,
    /revoke all privileges on table public\.%I from public, anon, authenticated/iu,
  );
  assert.match(sql, /grant all privileges on table public\.%I to service_role/iu);
  assert.match(
    sql,
    /create policy %I on public\.%I for all to service_role using \(true\) with check \(true\)/iu,
  );
  assert.match(
    sql,
    /revoke all privileges on function public\.claim_security_command\(text\) from public, anon, authenticated/iu,
  );
  assert.match(
    sql,
    /grant execute on function public\.claim_security_command\(text\) to service_role/iu,
  );
});

test("Supabase local Data API does not auto-expose future public tables", async () => {
  const config = await readFile(resolve(root, "supabase/config.toml"), "utf8");
  assert.match(config, /^\s*auto_expose_new_tables\s*=\s*false\s*$/mu);
});
