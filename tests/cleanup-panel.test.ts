import assert from "node:assert/strict";
import test from "node:test";
import {
  AutomaticMessageAction,
  buildAutomaticMessagePanel,
  buildCleanupSettingsPanel,
  CleanupAction,
  buildMainPanel,
  ModAction,
} from "../src/menus/panels.js";

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
