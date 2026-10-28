import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInactivityCleanConfirmPanel,
  buildInactivityLiveConfirmPanel,
  buildInactivityPanel,
  type Panel,
} from "../src/menus/panels.js";
import { initialGroupData } from "../src/storage/initial.js";

function callbacks(panel: Panel): string[] {
  return panel.keyboard.inline_keyboard
    .flat()
    .map((button) => ("callback_data" in button ? button.callback_data : undefined))
    .filter((value): value is string => typeof value === "string");
}

test("inactivity cleanup defaults to simulation and labels its non-destructive behavior", () => {
  const config = initialGroupData().inactivity;
  assert.equal(config.inactivityDays, 21);
  assert.equal(config.simulationMode, true);

  const panel = buildInactivityPanel(config, "Test");
  assert.match(panel.text, /simulación; no expulsa ni marca cuentas/);
  assert.ok(callbacks(panel).includes("ia:live"));
  assert.match(buildInactivityCleanConfirmPanel("Test").text, /No se expulsará a nadie/);
});

test("switching to real inactivity cleanup requires a separate explicit confirmation", () => {
  const panel = buildInactivityLiveConfirmPanel("Test");
  assert.match(panel.text, /ACTIVAR EXPULSIONES REALES/);
  assert.ok(callbacks(panel).includes("ia:live-confirm"));
  assert.ok(callbacks(panel).includes("ia:cancel"));
});

test("legacy inactivity settings without simulationMode remain in simulation", () => {
  const legacyConfig = {
    enabled: true,
    inactivityDays: 21,
  };
  assert.match(
    buildInactivityPanel(legacyConfig, "Legacy").text,
    /simulación; no expulsa ni marca cuentas/,
  );
  assert.match(
    buildInactivityCleanConfirmPanel("Legacy").text,
    /No se expulsará a nadie/,
  );
});
