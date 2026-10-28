import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCleanupSettingsPanel,
  buildFilterConfirmPanel,
  buildSubmenuPanel,
  type Panel,
} from "../src/menus/panels.js";

function buttonCallbacks(panel: Panel): string[] {
  return panel.keyboard.inline_keyboard
    .flat()
    .map((button) => ("callback_data" in button ? button.callback_data : undefined))
    .filter((value): value is string => typeof value === "string");
}

test("el submenú Filtros solo expone acciones cableadas (sin callbacks menu:action:)", () => {
  const panel = buildSubmenuPanel("filtros", "Grupo de prueba");
  assert.ok(panel);
  const callbacks = buttonCallbacks(panel);

  assert.ok(
    !callbacks.some((cb) => cb.startsWith("menu:action:")),
    `callbacks sin cablear: ${callbacks.join(",")}`,
  );
  for (const expected of [
    "fa:home",
    "fa:view:0",
    "fa:add",
    "fa:deletepage:0",
    "fa:toggle",
    "fa:illegal",
  ]) {
    assert.ok(callbacks.includes(expected), `falta ${expected}`);
  }
  assert.equal(
    callbacks.filter((cb) => cb.startsWith("fa:")).length,
    6,
    "los seis callbacks fa: del submenú deben estar presentes",
  );
  assert.ok(
    callbacks.every((cb) => cb.startsWith("fa:") || cb.startsWith("menu:")),
    `callbacks fuera de vocabulario: ${callbacks.join(",")}`,
  );
  assert.ok(
    callbacks.some((cb) => cb.startsWith("menu:")),
    "se esperan también botones de navegación menu:",
  );
});

test("el panel de Limpieza mantiene sus acciones reales sin callejones sin salida", () => {
  const panel = buildCleanupSettingsPanel({ autoDeleteServiceMessages: true });
  const callbacks = buttonCallbacks(panel);

  assert.ok(!callbacks.some((cb) => cb.startsWith("menu:action:")));
  for (const expected of [
    "cl:toggle",
    "ma:cleanup:10",
    "ma:cleanup:25",
    "ma:cleanup:50",
    "ma:cleanup:100",
  ]) {
    assert.ok(callbacks.includes(expected), `falta ${expected}`);
  }
});

test("la confirmación de eliminación de filtro usa callbacks cableados", () => {
  const callbacks = buttonCallbacks(buildFilterConfirmPanel("prueba"));
  assert.deepEqual(callbacks, ["fa:confirm", "fa:cancel"]);
});