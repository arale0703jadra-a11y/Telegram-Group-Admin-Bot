import assert from "node:assert/strict";
import test from "node:test";
import { detectIllegalContent } from "../src/filters/illegal-detector.js";

test("detects explicit phrases with Cyrillic homoglyphs and Unicode accents", () => {
  const result = detectIllegalContent("Аbúso sеxual infantil", []);

  assert.equal(result.critical, true);
  assert.equal(result.category, "child-abuse");
});

test("detects explicit phrases with punctuation, spaces, and repeated characters", () => {
  const result = detectIllegalContent("aabuuusooo s-e-x-u-a-l infantil", []);

  assert.equal(result.critical, true);
});

test("recognizes obfuscated short acronyms without treating them as severe alone", () => {
  const result = detectIllegalContent("c.p", []);

  assert.equal(result.confidence, "weak");
  assert.deepEqual(result.signals, ["ambiguous:cp"]);
});

test("requires contextual signals before a custom obfuscated term is high confidence", () => {
  const isolated = detectIllegalContent("c.p.c", ["cpc"]);
  const contextual = detectIllegalContent(
    "vendo fotos sexuales de menores: c.p.c",
    ["cpc"],
  );

  assert.equal(isolated.confidence, "suspicious");
  assert.equal(contextual.confidence, "high");
});
