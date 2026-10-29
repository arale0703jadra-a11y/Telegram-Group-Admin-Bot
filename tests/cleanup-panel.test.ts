import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  AutomaticMessageAction,
  buildAutomaticMessagePanel,
  buildCleanupSettingsPanel,
  CleanupAction,
  buildMainPanel,
  ModAction,
} from "../src/menus/panels.js";
import { cleanRecentMessages } from "../src/moderation/actions.js";
import { flushStorage, getGroupData, saveGroupData } from "../src/storage/index.js";
import type { MyContext } from "../src/types.js";

function buttonCallbacks(panel: ReturnType<typeof buildMainPanel>): Array<string | undefined> {
  return panel.keyboard.inline_keyboard.flat().map((button) =>
    "callback_data" in button ? button.callback_data : undefined
  );
}

test("cleanup panel exposes service-message auto-delete and quick purge actions", () => {
  const panel = buildCleanupSettingsPanel({
    autoDeleteServiceMessages: true,
  });
  const callbacks = buttonCallbacks(panel);

  assert.match(panel.text, /mensajes de servicio.*eliminan automáticamente/u);
  assert.match(panel.text, /ZEUS haya registrado/u);
  assert.ok(callbacks.includes(CleanupAction.toggle));
  for (const count of [10, 25, 50, 100]) {
    assert.ok(callbacks.includes(ModAction.cleanup(count)));
  }
});

test("cleanup panel reflects a disabled service-message deletion setting", () => {
  const panel = buildCleanupSettingsPanel({
    autoDeleteServiceMessages: false,
  });
  assert.equal(
    panel.keyboard.inline_keyboard[0]?.[0]?.text.includes("desactivada"),
    true,
  );
});

test("main menu restores verified users and recurring-message buttons", () => {
  const panel = buildMainPanel("Grupo de prueba");
  const buttons = panel.keyboard.inline_keyboard.flat();
  const callbacks = buttonCallbacks(panel);

  assert.ok(buttons.some((button) => button.text.includes("Verificadas")));
  assert.ok(buttons.some((button) => button.text.includes("Mensajes Recurrentes")));
  assert.ok(callbacks.includes("fa:verified"));
  assert.ok(callbacks.includes(AutomaticMessageAction.home));
});

test("recurring-message panel exposes configuration, schedule, toggle, and send-now", () => {
  const panel = buildAutomaticMessagePanel({
    enabled: false,
    message: "Aviso periódico",
    intervalMinutes: 60,
  });
  const callbacks = buttonCallbacks(panel);

  assert.match(panel.text, /Aviso periódico/u);
  for (const action of [
    AutomaticMessageAction.configure,
    AutomaticMessageAction.interval,
    AutomaticMessageAction.toggle,
    AutomaticMessageAction.sendNow,
  ]) {
    assert.ok(callbacks.includes(action));
  }
});

test("manual purge counts per-message failures instead of reporting full success", async () => {
  const groupId = -Math.floor(Date.now()) - 31;
  const file = resolve(process.cwd(), "data", "storage", `${groupId}.json`);
  const attemptedMessageIds: number[] = [];
  try {
    const data = await getGroupData(groupId);
    data.recentMessages = [101, 102, 103];
    await saveGroupData(groupId, data);
    await flushStorage();

    const ctx = {
      api: {
        deleteMessage: async (_chatId: number, messageId: number) => {
          attemptedMessageIds.push(messageId);
          if (messageId === 102) throw new Error("message cannot be deleted");
          return true;
        },
      },
    } as unknown as MyContext;

    const result = await cleanRecentMessages(ctx, groupId, 3);

    assert.deepEqual(attemptedMessageIds, [101, 102, 103]);
    assert.deepEqual(result, { attempted: 3, deleted: 2, failed: 1 });
  } finally {
    await flushStorage();
    if (existsSync(file)) unlinkSync(file);
  }
});

test("main menu does not expose unfinished rules or generic configuration buttons", () => {
  const callbacks = buttonCallbacks(buildMainPanel());
  assert.ok(!callbacks.includes("menu:sub:reglas"));
  assert.ok(!callbacks.includes("menu:sub:config"));
});
