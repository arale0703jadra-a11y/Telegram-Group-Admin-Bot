import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ILLEGAL_RISK_THRESHOLDS,
  detectIllegalContent,
} from "../src/filters/illegal-detector.js";

test("requires contextual intent before high-risk classification", () => {
  const isolated = detectIllegalContent("abuso sexual infantil", []);
  const offer = detectIllegalContent("vendo material: abuso sexual infantil", []);

  assert.equal(isolated.risk, "low");
  assert.equal(isolated.critical, false);
  assert.equal(offer.risk, "high");
  assert.equal(offer.intent, "sale");
  assert.equal(offer.critical, true);
});

test("normalizes homoglyphs, accents, inserted separators, and repeated characters", () => {
  const result = detectIllegalContent(
    "vеndo aabuuusooo s-e-x-u-a-l infantil",
    [],
  );

  assert.equal(result.risk, "high");
  assert.equal(result.normalizationApplied, true);
  assert.equal(result.explicitIntent, true);
});

test("normalizes invisible characters and numeric substitutions without standalone sanctions", () => {
  const isolated = detectIllegalContent("c\u200Bp3", []);
  const contextual = detectIllegalContent(
    "ofrezco s\u200Bepe por mensaje privado",
    [],
  );

  assert.equal(isolated.risk, "low");
  assert.equal(isolated.critical, false);
  assert.equal(contextual.risk, "high");
  assert.equal(contextual.signals.includes("coded-reference"), true);
});

test("near-miss spelling and phonetic code references need independent context", () => {
  const isolated = detectIllegalContent("sepee", []);
  const contextual = detectIllegalContent("cambio cp3 por mensaje privado", []);
  const misspelledIntent = detectIllegalContent("vendi material infantil ilegal", []);

  assert.equal(isolated.risk, "low");
  assert.equal(contextual.risk, "high");
  assert.equal(contextual.intent, "exchange");
  assert.equal(misspelledIntent.risk, "high");
  assert.equal(misspelledIntent.intent, "sale");
});

test("classifies sale, exchange, request, distribution, promotion, and grooming", () => {
  const cases = [
    ["vendo material infantil ilegal", "sale"],
    ["cambio material ilegal por mensaje privado", "exchange"],
    ["busco material de abuso infantil por dm", "request"],
    ["comparto material infantil ilegal en este grupo", "distribution"],
    ["canal privado con material infantil ilegal, entra aquí", "promotion"],
    ["adolescente, háblame por privado para conocernos", "grooming"],
  ] as const;

  for (const [text, expectedIntent] of cases) {
    const detection = detectIllegalContent(text, []);
    assert.ok(
      detection.risk === "medium" || detection.risk === "high",
      `${expectedIntent} should not be classified as low`,
    );
    assert.equal(detection.intent, expectedIntent, text);
  }
});

test("reports and educational context are not treated as an offer or request", () => {
  for (const text of [
    "denuncio una oferta ilegal para que los administradores la revisen",
    "noticia educativa sobre la prevención del abuso sexual infantil",
    "reporte de un canal que distribuye contenido ilegal",
    "Vendo una bicicleta. La prevención del abuso sexual infantil es importante.",
  ]) {
    const result = detectIllegalContent(text, []);
    assert.equal(result.risk, "low", text);
    assert.equal(result.intent, "informational", text);
    assert.equal(result.critical, false, text);
  }
});

test("isolated terms and ordinary messages do not trigger enforcement", () => {
  for (const text of [
    "cp",
    "cp3",
    "sepe",
    "menores estudiantes visitan el museo",
    "¿alguien recomienda un grupo de estudio?",
    "el canal de noticias publicó una alerta meteorológica",
  ]) {
    const result = detectIllegalContent(text, []);
    assert.equal(result.risk, "low", text);
    assert.equal(result.critical, false, text);
  }

  assert.equal(
    detectIllegalContent(
      "Vendo una bicicleta. El material infantil ilegal debe denunciarse.",
      [],
    ).risk,
    "low",
  );
});

test("links, forwarded status, and repeated conduct add explainable context only", () => {
  const linked = detectIllegalContent("cp3", [], { hasLink: true });
  const forwarded = detectIllegalContent("cp3", [], { forwarded: true });
  const repeated = detectIllegalContent("cp3", [], { repeatedCount: 2 });

  assert.equal(linked.risk, "medium");
  assert.equal(linked.signals.includes("link-or-forward-context"), true);
  assert.equal(forwarded.risk, "medium");
  assert.equal(repeated.risk, "medium");
  assert.equal(repeated.signals.includes("repeated-user-behavior"), true);
});

test("risk thresholds are configurable and validated", () => {
  const text = "vendo material infantil ilegal";
  assert.equal(
    detectIllegalContent(text, [], {}, {
      ...DEFAULT_ILLEGAL_RISK_THRESHOLDS,
      highContextSignals: 5,
    }).risk,
    "medium",
  );
  assert.throws(
    () => detectIllegalContent(text, [], {}, {
      highContextSignals: 0,
      mediumContextSignals: 1,
    }),
    /ILLEGAL_RISK_THRESHOLDS_INVALID/u,
  );
});
