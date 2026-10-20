import assert from "node:assert/strict";
import test from "node:test";
import { PROMOTION_DICTIONARY } from "../src/storage/initial.js";
import { detectPromotion } from "../src/filters/detector.js";

function detect(text: string, verified = false) {
  return detectPromotion(text, PROMOTION_DICTIONARY, { verified });
}

const sellerDirectionMessages = [
  "Vendo packs",
  "Quiero vender packs",
  "Ofrezco videollamadas",
  "Hago videos personalizados para clientes",
  "Acepto pedidos personalizados",
  "Mis clips están a la venta por 30 USD",
  "Hay descuento en mis packs hasta medianoche",
  "VENDO CLIPS $$$ solo gente seria al priv",
  "Les preparo packs temáticos; detalles por interno",
  "Busco clientes para mis sesiones personalizadas",
  "I sell photo sets in this chat",
  "I take commissions for custom videos",
];

for (const message of sellerDirectionMessages) {
  test(`author-directed offer is moderated: ${message}`, () => {
    const result = detect(message);
    assert.equal(result.intent, "SELLING");
    assert.equal(result.shouldModerate, true);
    assert.ok(result.confidence >= 0.8);
    assert.ok(result.sellingSignals.length > 0);
  });
}

const buyerDirectionMessages = [
  "Quiero comprar contenido",
  "Quién vende packs?",
  "Busco alguien que venda packs",
  "¿Vendes contenido?",
  "¿Tienes packs?",
  "Alguna chica hace sexting?",
  "Anyone selling photo sets in this chat?",
  "Any1 selling photo sets here?? 👀",
  "Alguien que venda photo sets por favor",
  "Looking for someone who sells clips",
  "Looking 4 someone who sells clips",
  "Could someone share their photo sets menu?",
  "Who takes custom orders for photo sets?",
  "I want to buy a pack",
  "Do you sell content?",
  "Who sells bundles here?",
];

for (const message of buyerDirectionMessages) {
  test(`buyer-directed request is allowed: ${message}`, () => {
    const result = detect(message);
    assert.equal(result.intent, "BUYING");
    assert.equal(result.shouldModerate, false);
    assert.ok(result.buyingSignals.length > 0);
  });
}

test("seeking a buyer is an author offer, not a request to buy", () => {
  for (const message of [
    "Busco comprador para mis packs",
    "Looking for a buyer for my clips",
  ]) {
    const result = detect(message);
    assert.equal(result.intent, "SELLING", message);
    assert.equal(result.shouldModerate, true, message);
  }
});

test("a buyer looking for a seller is not treated as the seller", () => {
  for (const message of [
    "Busco alguien que venda packs",
    "Busco una persona que venda clips",
    "Looking for someone selling clips",
  ]) {
    const result = detect(message);
    assert.equal(result.intent, "BUYING", message);
    assert.equal(result.shouldModerate, false, message);
  }
});

test("clear seller negations cannot trigger moderation", () => {
  for (const message of [
    "No vendo contenido",
    "Yo no vendo packs",
    "I don't sell photo sets",
    "I do not offer content",
  ]) {
    const result = detect(message);
    assert.notEqual(result.intent, "SELLING", message);
    assert.equal(result.shouldModerate, false, message);
  }
});

test("a negated sale followed by an active buyer request is buying", () => {
  const result = detect("No vendo contenido, pero busco alguien que venda");
  assert.equal(result.intent, "BUYING");
  assert.equal(result.shouldModerate, false);
});

test("third-person sellers are not attributed to the author", () => {
  for (const message of [
    "Mi amiga vende contenido",
    "My friend sells videos",
    "Conozco una chica que vende packs",
  ]) {
    const result = detect(message);
    assert.equal(result.intent, "NEUTRAL");
    assert.equal(result.shouldModerate, false);
  }
});

test("ordinary contexts containing commercial vocabulary remain neutral", () => {
  const messages = [
    "My work schedule is available in the shared calendar",
    "The new phone is not available in my country yet",
    "La señal de internet no está disponible en mi zona",
    "Hice un custom para mi avatar del videojuego",
    "El contenido privado del grupo es solo para miembros del curso",
    "I bought a photo pack for a work presentation",
    "My mother sent a video call link about photo sets",
    "The bank commission is listed on the monthly statement",
    "El menú del restaurante tiene precios nuevos",
  ];

  for (const message of messages) {
    const result = detect(message);
    assert.equal(result.intent, "NEUTRAL", message);
    assert.equal(result.shouldModerate, false, message);
  }
});

test("an owned item alone is ambiguous, while an owned offer is selling", () => {
  assert.equal(detect("Tengo packs").intent, "AMBIGUOUS");
  assert.equal(detect("Tengo contenido privado").intent, "AMBIGUOUS");
  assert.equal(detect("Tengo contenido exclusivo, escríbeme al DM").intent, "SELLING");
  assert.equal(detect("New content available, message me for the menu").intent, "SELLING");
});

test("contradictory buyer and seller directions are ambiguous and not moderated", () => {
  for (const message of [
    "Vendo packs, ¿cuánto cobras?",
    "Quiero comprar contenido, pero también vendo contenido",
    "I want to buy photo sets, but I also sell",
    "I sell photo sets, but I also want to buy one",
    "I offer photo sets, but I am also looking to buy",
    "Vendo photo sets, can I buy yours?",
    "Looking for both a buyer and a seller for photo sets",
    "I sell content but I want to buy yours",
    "Busco clientes y también busco una chica que venda",
  ]) {
    const result = detect(message);
    assert.equal(result.intent, "AMBIGUOUS", message);
    assert.equal(result.shouldModerate, false, message);
  }
});

test("links support textual intent but do not create it", () => {
  const alone = detectPromotion("https://example.com", []);
  assert.equal(alone.intent, "AMBIGUOUS");
  assert.equal(alone.hasLink, true);
  assert.equal(alone.shouldModerate, false);

  const selling = detect("Vendo mi galería: https://example.com");
  assert.equal(selling.intent, "SELLING");
  assert.equal(selling.shouldModerate, true);

  const buying = detect("¿Quién vende esto? https://example.com");
  assert.equal(buying.intent, "BUYING");
  assert.equal(buying.shouldModerate, false);
});

test("short commercial fragments remain ambiguous unless direction is clear", () => {
  for (const message of [
    "Vendo",
    "¿Vendes?",
    "¿Cuánto cobras?",
    "Disponible",
    "Custom",
    "PPV",
    "Precio",
  ]) {
    const result = detect(message);
    assert.equal(result.intent, "AMBIGUOUS", message);
    assert.equal(result.shouldModerate, false, message);
  }
});

test("verified sellers retain SELLING classification without moderation", () => {
  const result = detect("Vendo packs", true);
  assert.equal(result.intent, "SELLING");
  assert.equal(result.shouldModerate, false);
});

test("ordinary conversation and weak dictionary matches are not moderated", () => {
  for (const message of [
    "Hola",
    "Buenos días",
    "Quién es ella?",
    "Alguien conoce a esta chica?",
    "Está buena",
    "disponible",
    "precio",
    "videollamada",
    "privado",
    "paypal",
  ]) {
    assert.notEqual(detect(message).intent, "SELLING", message);
    assert.equal(detect(message).shouldModerate, false, message);
  }
});

test("adult niche vocabulary is contextual and only clear unverified offers are moderated", () => {
  for (const text of [
    "Vendo fotos de mis tetas",
    "Ofrezco sexting",
    "Soy escort, escríbeme al privado",
    "Vendo novia virtual por horas",
  ]) {
    const result = detect(text);
    assert.equal(result.intent, "SELLING", text);
    assert.equal(result.shouldModerate, true, text);
  }
  for (const text of [
    "Me gustan tus tetas",
    "Está buena",
    "¿Quién ofrece videollamadas?",
    "Qué culo tiene",
  ]) {
    const result = detect(text);
    assert.notEqual(result.intent, "SELLING", text);
    assert.equal(result.shouldModerate, false, text);
  }
});
