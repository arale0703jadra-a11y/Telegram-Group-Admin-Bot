import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVerifiedActionConfirmPanel,
  buildVerifiedPermissionConfirmPanel,
  buildRevokedVerifiedUsersPanel,
  buildVerifiedUserPanel,
  VerifiedAction,
  verifiedPermissionsSnapshot,
} from "../src/menus/panels.js";
import {
  DEFAULT_VERIFIED_PERMISSIONS,
  type VerifiedUser,
} from "../src/services/verified-users.js";
import { buttonCallbackData } from "./helpers.js";

function verifiedUser(
  changes: Partial<VerifiedUser> = {},
): VerifiedUser {
  return {
    id: "verified-1",
    group_id: -100123,
    user_id: 456,
    username: "sample",
    display_name: "Sample Member",
    verified: true,
    permissions: { ...DEFAULT_VERIFIED_PERMISSIONS },
    created_at: "2026-01-02T03:04:00.000Z",
    updated_at: "2026-01-02T03:04:00.000Z",
    created_by: 123,
    revoked_at: null,
    ...changes,
  };
}

test("verified profile shows IDs, Telegram membership, sanctions, and available histories", () => {
  const panel = buildVerifiedUserPanel(
    verifiedUser(),
    "Test group",
    "member",
    {
      groupId: -100123,
      currentUsername: "current_name",
      muteState: "Silenciada hasta mañana",
      banState: "No baneada según Telegram",
      warnings: [
        { date: "2026-01-02T03:04:00.000Z", reason: "Spam", revokedAt: null },
      ],
      events: [
        {
          eventType: "security_violation",
          createdAt: "2026-01-02T03:04:00.000Z",
          details: { result: "blocked" },
        },
      ],
      commands: [
        {
          action: "MUTE_USER",
          created_at: "2026-01-02T03:04:00.000Z",
          resultState: "completed",
          last_error: null,
        },
      ],
    },
  );

  assert.match(panel.text, /ID: 456/);
  assert.match(panel.text, /✅ Verificada/);
  assert.match(panel.text, /Grupo ID: -100123/);
  assert.match(panel.text, /@current\\_name/);
  assert.match(panel.text, /Estado Telegram: 👤 Miembro; En el grupo/);
  assert.match(panel.text, /Silenciada hasta mañana/);
  assert.match(panel.text, /Spam/);
  assert.match(panel.text, /security\\_violation/);
  assert.match(panel.text, /\[completed\]/);
  assert.ok(
    panel.keyboard.inline_keyboard.flat().some(
      (button) => buttonCallbackData(button) === VerifiedAction.revokeConfirm(456),
    ),
  );
});

test("verified profile keeps its badge after the informational validity date", () => {
  const panel = buildVerifiedUserPanel(
    verifiedUser({
      valid_until: "2020-01-01T00:00:00.000Z",
    }),
    "Test group",
    "member",
  );
  assert.match(panel.text, /✅ Verificada/);
  assert.match(panel.text, /la verificación sigue activa/);
});

test("non-functional link and fixed promotion permissions are informative, not toggle controls", () => {
  const panel = buildVerifiedUserPanel(verifiedUser(), "Test group", "member");
  const callbacks = panel.keyboard.inline_keyboard
    .flat()
    .map(buttonCallbackData);

  assert.match(panel.text, /Enlaces ordinarios ✅ \(no aplicado/);
  assert.match(panel.text, /Libertad promocional ❌ fija/);
  assert.ok(!callbacks.includes(VerifiedAction.toggle(456, "can_send_links")));
  assert.ok(!callbacks.includes(VerifiedAction.toggle(456, "bypass_promotion_filter")));
});

test("reactivation confirmation binds explicit permissions and does not imply sanction removal", () => {
  const record = verifiedUser({
    verified: false,
    revoked_at: "2026-02-01T00:00:00.000Z",
    permissions: {
      ...DEFAULT_VERIFIED_PERMISSIONS,
      bypass_illegal_filter: true,
    },
  });
  const panel = buildVerifiedActionConfirmPanel(record, "reactivate", "Test group");
  const applyButton = panel.keyboard.inline_keyboard.flat().find(
    (button) => button.text.includes("Confirmar"),
  );

  assert.match(panel.text, /las sanciones no se eliminarán/);
  assert.match(panel.text, /bypass_illegal_filter=sí/);
  assert.equal(
    buttonCallbackData(applyButton),
    VerifiedAction.reactivateApply(
      456,
      verifiedPermissionsSnapshot(record.permissions),
    ),
  );
});

test("permission changes require a confirmation naming the exact identity and value", () => {
  const panel = buildVerifiedPermissionConfirmPanel(
    verifiedUser(),
    "can_post",
    false,
    "Test group",
  );
  assert.match(panel.text, /Usuario ID: 456/);
  assert.match(panel.text, /Publicaciones/);
  assert.match(panel.text, /Nuevo estado: desactivado/);
  const applyButton = panel.keyboard.inline_keyboard
    .flat()
    .find((button) => button.text.includes("Confirmar"));
  assert.equal(
    buttonCallbackData(applyButton),
    VerifiedAction.permissionApply(456, "can_post", false, true),
  );
});

test("revoked records are paged so the panel does not exceed Telegram keyboard limits", () => {
  const records = Array.from({ length: 21 }, (_, index) =>
    verifiedUser({
      id: `verified-${index}`,
      user_id: 500 + index,
      verified: false,
      revoked_at: "2026-02-01T00:00:00.000Z",
    }),
  );
  const page = buildRevokedVerifiedUsersPanel(records, "Test group", 1);
  const buttons = page.keyboard.inline_keyboard.flat();

  assert.match(page.text, /Página 2 de 3/);
  assert.equal(
    buttons.filter((button) => buttonCallbackData(button)?.startsWith("vu:reactivate-confirm:")).length,
    10,
  );
  assert.ok(buttons.some((button) => buttonCallbackData(button) === "vu:revoked-list:0"));
  assert.ok(buttons.some((button) => buttonCallbackData(button) === "vu:revoked-list:2"));
});
