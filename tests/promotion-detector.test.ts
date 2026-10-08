import assert from "node:assert/strict";
import test from "node:test";
import {
  detectPromotion,
  normalizeFilterTerm,
} from "../src/filters/detector.js";
import { PROMOTION_DICTIONARY } from "../src/storage/initial.js";

const buyingMessages = [
  "¿Cuánto cobras?",
  "¿Cuánto cobras por una videollamada?",
  "¿Cuánto cuesta una videollamada?",
  "Busco una chica para una videollamada.",
  "¿Tienes packs?",
  "¿Qué contenido tienes disponible?",
  "¿Me pasas los precios?",
  "¿Haces llamadas?",
  "Quiero comprar un pack.",
  "Busco contenido personalizado.",
  "¿Aceptas PayPal?",
  "¿Alguna chica hace sexting?",
  "¿Cuánto cuesta el contenido?",
  "¿Quién vende packs?",
  "¿Quién hace videollamadas?",
  "¿Dónde consigo videos personalizados?",
  "Quisiera contratar una llamada.",
  "Necesito fotos privadas.",
  "¿Cuánto valen tus videos?",
  "¿Qué servicios ofreces?",
  "¿Tienen catálogo?",
  "¿Hay videos personalizados?",
  "¿Me vendes un pack?",
  "¿Puedo comprar contenido por privado?",
  "Ando buscando packs nuevos.",
  "¿Cobras por las llamadas?",
  "¿Recibes transferencias?",
  "Me interesa comprar el contenido que publicas.",
  "¿Hay disponibilidad para videollamadas?",
  "¿Alguien que venda fotos?",
  "¿Cuál es el precio de un pack?",
  "¿Me pasas el catálogo?",
  "Q tienes de contenido?",
  "Busco videollamada, porfa.",
  "¿Vendes contenido?",
  "¿Haces customs?",
  "¿Qué contenido tienes?",
  "¿Tienes packs de fotos?",
  "¿Me puedes mandar tu menú?",
  "¿Cuánto cuesta el contenido?",
  "¿Cuál es el precio del pack?",
  "¿Cuánto cobras por fotos privadas?",
  "¿Aceptas PayPal para el contenido?",
  "¿Me pasas tu price list?",
  "Quiero comprar un pack de fotos.",
  "Busco una chica para videollamada.",
  "Busco videos personalizados, por favor.",
  "¿Alguna hace llamadas?",
  "¿Alguien vende contenido por aquí?",
  "¿Dónde puedo comprar un pack?",
  "Do you have content?",
  "Do you sell packs?",
  "Do you make customs?",
  "How much do you charge for a call?",
  "What content do you have?",
  "What are your prices?",
  "Can I buy a pack?",
  "I want to buy private content.",
  "Looking for a girl for a video call.",
  "Who sells photos?",
  "Can you send me your menu?",
  "Do you accept PayPal?",
  "¿Me muestras tus videos?",
  "¿Qué servicios haces?",
  "¿Vendes fotos y videos?",
  "Busco contenido",
  "Busco packs",
  "Busco una chica",
  "Busco una videollamada",
  "¿Tienes contenido disponible?",
  "¿Tienes packs disponibles?",
  "¿Aceptas encargos?",
  "¿Aceptas pedidos?",
  "¿Cuánto cuesta?",
  "¿Cuál es el precio?",
  "¿Qué precio?",
  "Do you sell content?",
  "Do you sell packs?",
  "Do you have content?",
  "Do you have packs?",
  "Do you do customs?",
  "Do you accept commissions?",
  "How much?",
  "How much do you charge?",
  "Can I see your menu?",
  "I'm looking for content",
  "I want to buy content",
  "Looking for a girl",
  "¿Quién vende contenido aquí?",
  "Quiero comprar contenido, tengo PayPal",
];

const sellingMessages = [
  "Vendo packs.",
  "Vendo contenido privado.",
  "Ofrezco videollamadas.",
  "Hago videos personalizados.",
  "Tengo contenido exclusivo, DM.",
  "Vendo fotos y videos.",
  "Estoy tomando pedidos personalizados.",
  "Tengo packs disponibles, escríbeme.",
  "Ofrezco contenido privado por DM.",
  "Estoy vendiendo mis videos.",
  "Hago videollamadas por dinero.",
  "Tengo catálogo de contenido a la venta.",
  "Contrátame para una videollamada.",
  "Promoción: pack disponible por 10 dólares.",
  "Vendo contenido por PayPal.",
  "Packs de fotos a la venta.",
  "Te ofrezco videos personalizados.",
  "Realizo llamadas privadas por pago.",
  "Acepto pedidos de fotos personalizadas.",
  "Estoy promocionando mi contenido premium.",
  "Mi catálogo está en venta por 20 USD.",
  "Tengo videos exclusivos, interesados al privado.",
  "Vendo mis packs por diez dólares.",
  "Ofrezco sesiones de sexting pagadas.",
  "Hacemos videollamadas privadas por 15 USD.",
  "Publicito mi menú de servicios, escríbeme.",
  "Vendo paquetes de fotos y videos.",
  "Tengo contenido personalizado por encargo y cobro por PayPal.",
  "Voy a vender mis videos en este grupo.",
  "Promoción de videollamadas: reserva por DM, 10 USD.",
  "Mis fotos están a la venta, háblame al privado.",
  "Ofrecemos packs exclusivos por transferencia.",
  "Estoy tomando pedidos para videos, desde 5 dólares.",
  "Contrátanos para llamadas privadas.",
  "Tengo packs disponibles.",
  "Tengo contenido disponible.",
  "Packs disponibles por privado.",
  "Contenido disponible, escríbeme.",
  "Tengo packs disponibles, DM.",
  "Te paso precios por privado.",
  "Si quieres te paso precios.",
  "Te paso mi menú.",
  "Te puedo enseñar mis packs por privado.",
  "Si te interesa mi contenido, escríbeme.",
  "DM if interested in my pack.",
  "Interested? DM for my photos.",
  "I sell content.",
  "I'm selling packs.",
  "I offer private calls.",
  "I make custom videos.",
  "I have packs available.",
  "My content is available, message me.",
  "Content available, DM me.",
  "Packs available, message me.",
  "I take custom requests.",
  "I take commissions for custom videos.",
  "My videos cost $30.",
  "I have a private content menu in DM.",
  "Offering custom content by private message.",
  "Vendo mis fotos por PayPal.",
  "Ofrezco customs por DM.",
  "Estoy tomando pedidos por privado.",
  "Mi menú está disponible por DM.",
  "Vendo contenido, mira https://example.com",
  "I sell packs: https://example.com",
  "Busco comprador para mis packs",
  "Busco quien compre mi contenido",
  "Busco interesados en mis videos",
  "Busco clientes para mis videollamadas",
  "Busco personas interesadas en mi contenido",
  "Tengo contenido exclusivo",
  "Tengo contenido premium",
  "Tengo contenido privado",
  "Tengo contenido personalizado",
  "Tengo contenido por encargo",
  "Tengo contenido a pedido",
  "Tengo contenido al privado",
  "Tengo packs exclusivos",
  "Tengo videos disponibles",
  "Tengo fotos disponibles",
  "Hago contenido por encargo",
  "Contenido por encargo",
  "Videos por encargo",
  "Fotos por encargo",
  "Acepto encargos",
  "Acepto pedidos",
  "Tomo pedidos",
  "Hago pedidos personalizados",
  "Hago contenido personalizado",
  "Hago videos personalizados",
  "Tengo menú disponible",
  "Interesados al DM por mis fotos",
  "DM si te interesa mi pack",
  "Escríbeme al privado por mis videos",
  "Busco compradores para mis packs",
  "Busco quien compre mi contenido",
  "Busco interesados en mis videos",
  "Busco clientes para mis servicios",
  "I offer content",
  "I offer customs",
  "I do customs",
  "I have content available",
  "Content available, DM",
  "Packs available, DM",
  "Prices in DM",
  "Menu in DM",
  "I take commissions",
  "I accept commissions",
  "I take custom orders",
  "I accept custom orders",
  "Custom orders available",
  "I make custom content",
  "I make custom videos",
  "I'm looking for buyers for my packs",
  "Looking for buyers for my content",
  "Looking for customers for my videos",
  "Content available, DM 🔥",
  "Vendo packs 🔥💌",
];

const neutralMessages = [
  "Hola.",
  "Buenos días.",
  "Alguien conoce a esta chica?",
  "Quién es ella?",
  "Está buena.",
  "Tengo una pregunta.",
  "Hoy tuve una videollamada con mi novio.",
  "El precio me parece caro.",
  "Me gusta ver videos.",
  "Qué contenido publican aquí?",
  "Estoy disponible mañana para conversar.",
  "No vendo nada, solo estoy preguntando.",
  "Alguien conoce una buena plataforma?",
  "Me gusta el contenido de esta página.",
  "Ayer vi videos muy graciosos.",
  "Subieron fotos del evento.",
  "El pack de fotos salió bien.",
  "Este video parece viejo.",
  "El precio de la entrada subió.",
  "Vi la videollamada del evento.",
  "Qué contenido publican en el canal?",
  "Estoy disponible para hablar luego.",
  "Vimos un video en clase.",
  "El álbum familiar quedó bonito.",
  "Me parece caro ese precio, nada más.",
  "Hablamos de servicios de internet en la reunión.",
  "La llamada con mi mamá duró una hora.",
  "Compartieron fotos del paseo.",
  "Publicaron videos del concierto.",
  "No ofrezco servicios, solo comento.",
  "Me gusta el menú nuevo del restaurante.",
  "El contenido de la clase es interesante.",
  "Mi novio y yo tuvimos una llamada anoche.",
  "La plataforma publicó su catálogo anual.",
  "Hago videos para la escuela.",
  "Hago videollamadas con mis amigas.",
  "Vendo mi auto. Me gusta ver videos.",
  "Hoy hice una videollamada con mi pareja.",
  "El precio del taxi está caro.",
  "Me gusta ver videos de viajes.",
  "¿Qué contenido publican en la universidad?",
  "Estoy disponible mañana para una reunión.",
  "Tengo una pregunta sobre la clase.",
  "Hago videos para un proyecto de la escuela.",
  "El catálogo de la biblioteca es público.",
  "Compartieron fotos del paseo.",
  "La llamada con mi mamá fue larga.",
  "Me parece caro el precio del hotel.",
  "¿Alguien conoce una plataforma educativa?",
  "Estoy de viaje y tengo poco tiempo.",
  "Mi contenido favorito es de historia.",
  "Vimos un video en la oficina.",
  "El menú del restaurante tiene precios nuevos.",
  "No ofrezco nada, solo hago una pregunta.",
  "I had a video call with my boyfriend.",
  "The price of the ticket went up.",
  "I like watching videos.",
  "I'm available tomorrow to talk.",
  "This is a public educational platform.",
  "We shared photos from the trip.",
  "Disponible para hablar.",
  "I have a question about the price.",
  "The price seems too high.",
  "Ofrezco contenido educativo para la clase.",
  "Tengo contenido para la universidad",
  "Tengo packs de fotos de mi viaje",
  "Hago videos para un proyecto escolar",
  "Estoy disponible mañana para una reunión",
  "Hoy hice una videollamada con mi pareja",
  "El menú del restaurante tiene precios nuevos",
  "¿Cuánto cuesta el teléfono?",
  "Estoy buscando trabajo",
  "I don't sell anything",
  "I'm available tomorrow to talk",
];

const ambiguousMessages = [
  "Precio.",
  "Disponible.",
  "Privado.",
  "Contenido.",
  "Videollamada.",
  "¿Cuánto?",
  "Tengo packs.",
  "Estoy buscando una chica para hablar.",
  "Estoy disponible mañana.",
  "Videollamada privada.",
  "Contenido privado.",
  "Packs exclusivos.",
  "Fotos personalizadas.",
  "DM.",
  "Escríbeme.",
  "Info.",
  "Paypal.",
  "Reservas.",
  "Catálogo.",
  "Servicio privado.",
  "Videos disponibles.",
  "Tengo contenido.",
  "¿Mañana estás disponible?",
  "Quiero hablar en privado.",
  "Un pack de fotos.",
  "Contenido por DM.",
  "Disponible para videollamada.",
  "¿Cuánto cobras y yo vendo packs?",
  "Busco comprador, vendo contenido.",
  "Hago videos.",
  "Hago videollamadas.",
  "Vendo. Contenido.",
  "Enlace: https://example.com",
  "Mira esto https://example.com",
  "Privado por favor.",
  "Tengo contenido.",
  "Tengo videos.",
  "Tengo un menú.",
  "Busco una chica para hablar.",
  "Estoy buscando a alguien.",
  "¿Cuánto?",
  "¿Quieres vender contenido?",
  "¿Cuánto cuesta mañana?",
  "Packs.",
  "Contenido disponible.",
  "Available content.",
  "Private video call.",
  "DM me.",
  "Message me.",
  "I have content.",
  "I can send you something by DM.",
  "Disponible mañana.",
  "A private call.",
  "Content by DM.",
  "Video call https://example.com",
  "https://example.com/mi-contenido",
  "Busco una chica para videollamada y vendo contenido.",
  "Vendo packs, ¿tú qué vendes?",
  "I sell content, but who sells photos?",
  "Tengo packs disponibles, ¿qué contenido tienes?",
  "Tengo contenido, ¿qué precio tienes?",
  "Vendo packs, ¿cuánto cobras?",
  "Yo vendo contenido, ¿tú vendes?",
  "Vendo packs y busco una chica",
  "¿Quieres vender contenido aquí?",
  "Busco una chica que venda packs",
  "I'm looking for someone who sells packs",
];

function assertIntentCases(messages: string[], intent: string): void {
  for (const message of messages) {
    test(`${intent} classification: ${message}`, () => {
      const result = detectPromotion(message, PROMOTION_DICTIONARY);
      assert.equal(result.intent, intent);
      assert.equal(
        result.shouldModerate,
        intent === "SELLING",
        `unexpected moderation for ${message}`,
      );
    });
  }
}

assertIntentCases(buyingMessages, "BUYING");
assertIntentCases(sellingMessages, "SELLING");
assertIntentCases(neutralMessages, "NEUTRAL");
assertIntentCases(ambiguousMessages, "AMBIGUOUS");

test("all ambiguous examples are fail-open even when they contain commercial vocabulary", () => {
  for (const message of ambiguousMessages) {
    assert.equal(detectPromotion(message, PROMOTION_DICTIONARY).shouldModerate, false);
  }
});

test("selling messages are allowed for verified authors without changing their intent", () => {
  const verified = detectPromotion("Vendo packs", PROMOTION_DICTIONARY, {
    verified: true,
  });
  assert.equal(verified.intent, "SELLING");
  assert.equal(verified.shouldModerate, false);
});

test("confidence increases with explicit ownership and offer evidence", () => {
  const isolatedProduct = detectPromotion("Packs", PROMOTION_DICTIONARY);
  const ownedProduct = detectPromotion("Tengo packs", PROMOTION_DICTIONARY);
  const contextualOffer = detectPromotion(
    "Tengo packs, DM",
    PROMOTION_DICTIONARY,
  );
  const explicitAvailability = detectPromotion(
    "Tengo packs disponibles",
    PROMOTION_DICTIONARY,
  );
  const explicitSale = detectPromotion("Vendo packs", PROMOTION_DICTIONARY);

  assert.equal(isolatedProduct.intent, "AMBIGUOUS");
  assert.equal(ownedProduct.intent, "AMBIGUOUS");
  assert.ok(isolatedProduct.confidence < contextualOffer.confidence);
  assert.ok(ownedProduct.confidence < contextualOffer.confidence);
  assert.ok(contextualOffer.confidence < explicitAvailability.confidence);
  assert.ok(explicitAvailability.confidence < explicitSale.confidence);
});

test("links are additional signals and do not independently trigger promotion moderation", () => {
  for (const message of [
    "https://example.com",
    "Mira esto https://example.com",
    "Busco contenido en este enlace https://example.com",
  ]) {
    const result = detectPromotion(message, PROMOTION_DICTIONARY);
    assert.equal(result.hasLink, true);
    assert.notEqual(result.intent, "SELLING");
    assert.equal(result.shouldModerate, false);
  }
});

test("a commercial offer accompanied by a URL remains SELLING", () => {
  const result = detectPromotion(
    "Vendo contenido https://example.com",
    PROMOTION_DICTIONARY,
  );
  assert.equal(result.intent, "SELLING");
  assert.equal(result.hasLink, true);
  assert.equal(result.shouldModerate, true);
});

test("normalization handles accents, casing, repeated whitespace, punctuation, and common q abbreviation", () => {
  assert.equal(normalizeFilterTerm("  ¿QUÉ   CONTENIDO,\n tienes? "), "que contenido tienes");
  assert.equal(normalizeFilterTerm("PRecio\u00A0y con\u200Btenido"), "precio y contenido");
  for (const message of [
    "Q tienes de contenido?",
    "¿QUÉ CONTENIDO TIENES DISPONIBLE?",
    "  ¿Me   pasas\nlos precios? ",
    "BUSCO\u00A0con\u200Btenido",
  ]) {
    assert.equal(detectPromotion(message, PROMOTION_DICTIONARY).intent, "BUYING");
  }
});

test("limited common spelling errors and emoji punctuation preserve clear buying and selling intent", () => {
  for (const message of [
    "Busco una chica para videollamda.",
    "¿Q precio tiene un pack?",
    "¿Cuál es el presio del contenido?",
    "Busco contneido personalizado.",
    "¿Cuánto cuesta una video llamada?",
  ]) {
    const result = detectPromotion(message, PROMOTION_DICTIONARY);
    assert.equal(result.intent, "BUYING", message);
    assert.equal(result.shouldModerate, false, message);
  }

  for (const message of [
    "VENDO 🔥 packs disponibles, escríbeme 💌",
    "Vendo packs x 10 USD, DM 😈",
  ]) {
    const result = detectPromotion(message, PROMOTION_DICTIONARY);
    assert.equal(result.intent, "SELLING", message);
    assert.equal(result.shouldModerate, true, message);
  }

  const neutral = detectPromotion(
    "El precio 😅 me parece caro, nada más.",
    PROMOTION_DICTIONARY,
  );
  assert.equal(neutral.intent, "NEUTRAL");
  assert.equal(neutral.shouldModerate, false);
});

test("a negated selling phrase does not become an offer unless a separate positive offer exists", () => {
  const denied = detectPromotion(
    "No vendo nada, solo estoy preguntando.",
    PROMOTION_DICTIONARY,
  );
  assert.equal(denied.intent, "NEUTRAL");
  assert.equal(denied.shouldModerate, false);

  const mixed = detectPromotion(
    "No vendo eso, pero ofrezco packs por DM.",
    PROMOTION_DICTIONARY,
  );
  assert.equal(mixed.intent, "SELLING");
  assert.equal(mixed.shouldModerate, true);
});

test("selling and buying cues in separate clauses do not combine into an automatic promotion", () => {
  const result = detectPromotion(
    "Vendo mi auto. Me gusta ver videos.",
    PROMOTION_DICTIONARY,
  );
  assert.notEqual(result.intent, "SELLING");
  assert.equal(result.shouldModerate, false);

  const explicitContradiction = detectPromotion(
    "Vendo packs. ¿Cuánto cobras por una videollamada?",
    PROMOTION_DICTIONARY,
  );
  assert.equal(explicitContradiction.intent, "AMBIGUOUS");
  assert.equal(explicitContradiction.shouldModerate, false);
});

test("direct payment and price questions are buying, not selling", () => {
  for (const message of [
    "¿Aceptas PayPal?",
    "¿Cuánto cobras?",
    "¿Cuál es el precio de la videollamada?",
  ]) {
    const result = detectPromotion(message, PROMOTION_DICTIONARY);
    assert.equal(result.intent, "BUYING");
    assert.equal(result.shouldModerate, false);
  }
});

test("dictionary terms alone do not create selling intent", () => {
  for (const message of ["precio", "disponible", "privado", "videollamada", "contenido"]) {
    const result = detectPromotion(message, PROMOTION_DICTIONARY);
    assert.notEqual(result.intent, "SELLING");
    assert.equal(result.shouldModerate, false);
  }
});

test("adversarial direction distinguishes seeking buyers from seeking providers", () => {
  const cases = [
    ["Busco contenido", "BUYING"],
    ["Busco comprador para mi contenido", "SELLING"],
    ["Busco alguien que venda contenido", "BUYING"],
    ["Busco clientes para mi contenido", "SELLING"],
    ["Quiero comprar contenido", "BUYING"],
    ["Quiero vender contenido", "SELLING"],
    ["Busco alguien que compre mis packs", "SELLING"],
    ["Busco alguien que me venda packs", "BUYING"],
    ["Looking for buyers for my content", "SELLING"],
    ["Looking for someone who sells content", "BUYING"],
    ["Tengo contenido", "AMBIGUOUS"],
    ["Tengo contenido disponible", "SELLING"],
    ["¿Tienes contenido?", "BUYING"],
    ["Vendo contenido", "SELLING"],
    ["¿Vendes contenido?", "BUYING"],
    ["Hago customs", "SELLING"],
    ["¿Haces customs?", "BUYING"],
    ["Busco una creadora", "BUYING"],
  ] as const;

  for (const [message, expected] of cases) {
    const result = detectPromotion(message, PROMOTION_DICTIONARY);
    assert.equal(result.intent, expected, message);
    assert.equal(result.shouldModerate, expected === "SELLING", message);
  }
});

test("contradictory selling and buying messages are always fail-open", () => {
  for (const message of [
    "Vendo packs pero quiero comprar uno",
    "Busco clientes y también busco una chica",
    "Quiero comprar contenido, pero también vendo contenido",
    "Vendo mis videos, ¿tú cuánto cobras?",
    "Busco comprador, ¿cuánto cobras tú?",
    "I sell content but I want to buy yours",
    "I'm looking for buyers and sellers",
  ]) {
    const result = detectPromotion(message, PROMOTION_DICTIONARY);
    assert.equal(result.intent, "AMBIGUOUS", message);
    assert.equal(result.shouldModerate, false, message);
  }
});

test("ordinary messages with commercial vocabulary remain non-promotional", () => {
  for (const message of [
    "Tengo material para mi proyecto",
    "Tengo cosas nuevas para la universidad",
    "Estoy disponible mañana para hablar",
    "Busco clientes para mi trabajo de diseño",
    "Hago videos para YouTube",
    "Tengo un pack de fotos de mis vacaciones",
    "El precio de ese teléfono está caro",
    "Estoy buscando trabajo",
    "Hoy hice una videollamada con mi mamá",
    "Tengo contenido para una presentación",
    "Estoy tomando pedidos para mi emprendimiento de comida",
    "Mi menú tiene precios nuevos",
    "Estoy ofreciendo un servicio de diseño",
    "Busco interesados para una encuesta",
    "I have material for school",
    "I'm available tomorrow to talk",
    "I'm looking for a job",
    "I make videos for YouTube",
    "The phone price is too high",
    "I'm offering graphic design services",
  ]) {
    const result = detectPromotion(message, PROMOTION_DICTIONARY);
    assert.notEqual(result.intent, "SELLING", message);
    assert.equal(result.shouldModerate, false, message);
  }
});
