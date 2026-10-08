export type PromotionIntent = "BUYING" | "SELLING" | "NEUTRAL" | "AMBIGUOUS";

export type PromotionSignal =
  | "sale"
  | "payment"
  | "contact"
  | "adult"
  | "offer"
  | "link";

export interface PromotionDetection {
  intent: PromotionIntent;
  confidence: number;
  buyingSignals: string[];
  sellingSignals: string[];
  contactSignals: string[];
  commercialSignals: string[];
  matches: string[];
  signals: Set<PromotionSignal>;
  hasLink: boolean;
  shouldModerate: boolean;
  reason: string;
}

export const BUYING_SIGNAL_EXAMPLES = [
  "busco",
  "quiero comprar",
  "quiero ver",
  "quiero pedir",
  "quien vende",
  "quien hace",
  "alguna chica",
  "donde consigo",
  "cuanto cuesta",
  "que precio tiene",
  "cuanto sale",
] as const;

export const SELLING_SIGNAL_EXAMPLES = [
  "vendo",
  "ofrezco",
  "tengo contenido",
  "hago videos",
  "realizo videollamadas",
  "acepto pedidos",
  "estoy tomando pedidos",
  "mi contenido",
  "promociono",
] as const;

export const CONTACT_SIGNAL_EXAMPLES = [
  "escribeme",
  "hablame",
  "contactame",
  "dm",
  "inbox",
  "interesados al privado",
  "escribeme al privado",
  "habla conmigo",
  "mandame mensaje",
  "para comprar",
  "compra aqui",
  "pedidos por privado",
] as const;

const CONTACT_PATTERN =
  /\b(?:dm|inbox|directo|escribeme|hablame|contactame|interesados?|por privado|al privado|habla conmigo|mandame mensaje|mensajeame|para comprar|compra aqui|pedidos por privado)\b/u;
const LINK_PATTERN = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/iu;

const BUYING_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:busco|buscando)\b/u, "busco"],
  [/\bquiero comprar\b/u, "quiero comprar"],
  [/\bquiero ver\b/u, "quiero ver"],
  [/\bquiero pedir\b/u, "quiero pedir"],
  [/\b(?:quiero|quisiera|necesito|me interesa)\b/u, "quiero/necesito"],
  [/\bquien(?:es)?\s+(?:vende|venden|hace|hacen|ofrece|ofrecen)\b/u, "quien ofrece"],
  [/\balguna chica\b/u, "alguna chica"],
  [/\b(?:busco|necesito|quiero)\s+(?:una?\s+)?(?:chica|alguien|persona)\b/u, "busco alguien"],
  [/\bdonde consigo\b/u, "donde consigo"],
  [/\bcuanto cuesta\b/u, "cuanto cuesta"],
  [/\bque precio tiene\b/u, "que precio tiene"],
  [/\bcuanto sale\b/u, "cuanto sale"],
  [/\b(?:busco|quiero|necesito)\s+(?:videos?|fotos?|packs?|contenido|videollamadas?)\b/u, "busqueda de contenido"],
  [/\bque chica\b.{0,50}\b(?:disponible|hace|ofrece)\b/u, "pregunta por disponibilidad"],
  [/\b(?:alguien|alguna chica)\s+que\s+haga\b/u, "pregunta por servicio"],
];

const EXPLICIT_SELLING_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:vendo|vendemos|ofrezco|ofrecemos)\b/u, "oferta en primera persona"],
  [/\b(?:quiero|puedo|voy a|planeo)\s+vender\b/u, "intencion de vender"],
  [/\b(?:hago|hacemos|realizo|realizamos)\b/u, "servicio en primera persona"],
  [/\b(?:acepto|tom[oó]|estoy tomando)\s+pedidos?\b/u, "acepta pedidos"],
  [/\b(?:promociono|promocionando)\b/u, "autopromocion"],
];

export function normalizeFilterTerm(value: string): string {
  return value
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[¿?¡!,.;:]/g, "")
    .replace(/\bq\b/g, "que")
    .replace(/\bcontneido\b/g, "contenido")
    .replace(/\bpresio\b/g, "precio")
    .replace(/\bvideollamda\b/g, "videollamada")
    .replace(/\bvideo llamada\b/g, "videollamada");
}

function containsTerm(text: string, term: string): boolean {
  const escaped = normalizeFilterTerm(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
    "u",
  ).test(text);
}

function collectSignals(
  text: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
): string[] {
  return patterns
    .filter(([pattern]) => pattern.test(text))
    .map(([, signal]) => signal);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const NEGATED_SELLING_PATTERN =
  /\b(?:no|nunca|jamas)\s+(?:vendo|vender|ofrezco|ofrecer|hago|realizo)\b/u;
const NEUTRAL_CONTEXT_PATTERN =
  /\b(?:escuela|universidad|clase|proyecto|presentacion|trabajo|empleo|encuesta|restaurante|comida|emprendimiento|diseno|youtube|auto|telefono|hotel|taxi|boleto|biblioteca|viaje|vacaciones|vacacion|paseo|evento|novio|novia|pareja|mama|familia|familiares?|amigas?|hermana|sister|oficina|historia|reunion|boyfriend|girlfriend|school|university|meeting|survey|restaurant|food|design|library|trip|vacation|ticket)\b/u;
const SEXUAL_CONTEXT_PATTERN =
  /\b(?:adult[oa]s?|desnud[oa]s?|nudes?|sexting|\+18|18\+|customs?|packs?|contenido|content|material|fotos?|photos?|videos?|videollamadas?|llamadas?|private calls?)\b/u;
const COMMERCIAL_OBJECT_FOR_OFFER =
  /\b(?:contenido|content|material|packs?|paquetes?|catalogo|catalog|menu|fotos?|photos?|videos?|nudes?|pics?|sexting|videollamadas?|llamadas?|calls?|customs?|personalizad[oa]s?|servicio|servicios|service|services|pedido|pedidos|encargo|encargos|order|orders|comisiones|commission|commissions|cliente|clientes|customer|customers|comprador|compradores|buyer|buyers|privad[oa]s?|private|precio|precios|price|prices|disponible|disponibles|available|custom|paypal|reservas?|info|informacion|ppv|opciones|options)\b/u;
const BUYING_ACTION_PATTERN =
  /\b(?:busco|buscando|quiero|quisiera|quiero saber|necesito|me interesa|cuanto|que precio|quien|alguien|alguna|aceptas|aceptan|haces|hace|tienes|tienen|hay|vendes|vende|venden|ofrece|ofreces|ofrecen|comprar|buy|looking for|want to buy|want to order|who sells|who does|who makes|does anyone|can someone|do you|what do you|how much|accept paypal|send me|show me|can i see|where can i|get|pasas|muestras|mandas|consigo|cobras|recibes)\b/u;
const CTA_PATTERN =
  /\b(?:dm|inbox|escribeme|hablame|contactame|interesados?|por privado|al privado|mensajeame|mandame mensaje|si te interesa|si quieren|interested|message me|dm me|by dm)\b/u;
const BUYER_SEEKING_SELLER_PATTERN =
  /\b(?:busco|buscando|looking for)\b.{0,45}\b(?:alguien|una chica|una creadora|alguien que|someone|a creator|a girl|who)\b.{0,30}\b(?:venda|vende|venden|haga|hace|ofrezca|sells|does|offers)\b/u;
const AMBIGUOUS_PACK_PROVIDER_PATTERN =
  /\b(?:busco|buscando|looking for)\b.{0,80}\b(?:venda|vende|sells)\s+packs?\b/u;
const SEEKING_BUYERS_PATTERN =
  /\b(?:busco|buscando|looking for)\b.{0,60}\b(?:clientes?|comprador(?:es)?|interesad[oa]s?|buyers?|customers?|people interested|quien compre|who buys|alguien que compre|someone to buy)\b/u;
const NEGATED_OFFER_CONTEXT =
  /\b(?:no vendo nada|no ofrezco nada|i don't sell anything|i do not sell anything)\b/u;
const CONVERSATIONAL_ACTION_PATTERN =
  /\b(?:me gusta|vi|vimos|hice|tuve|tuvimos|compartieron|publicaron|had|watched|like watching|shared|published|saw|disponible para hablar)\b/u;
const BUYING_QUESTION_PATTERN =
  /\b(?:quien tiene|who has|cuanto cobras|cuanto cuesta$|cuanto vale|que precio|aceptas paypal|recibes transferencias|me pasas|me muestras|me puedes mandar|do you accept paypal|how much(?: do you charge)?|what are your prices|can you send me|can i see)\b/u;
const STRONG_SELLING_CLAUSE_PATTERN =
  /\b(?:vendo|vendiendo|vendemos|vender|ofrezco|ofreciendo|ofrecemos|ofrecer|acepto|aceptando|estoy aceptando|tom[oó]|estoy tomando|promociono|promocionando|a la venta|en venta|contratame|contratanos|selling|i sell|i'm selling|i am selling|i offer|i'm offering|i am offering|taking|accepting|offering|i take commissions|i accept commissions)\b/u;
const SELLING_OBJECT_PATTERN =
  /\b(?:contenido|content|material|packs?|paquetes?|catalogo|catalog|menu|fotos?|photos?|videos?|nudes?|pics?|sexting|videollamadas?|llamadas?|calls?|customs?|personalizad[oa]s?|pedidos?|encargos?|orders?|contenido adulto|mi contenido|mis fotos|my content|my packs?|my photos|my videos?|private calls?|custom videos?|custom orders?|requests?)\b/u;
const AUDIENCE_INVITATION_PATTERN =
  /\b(?:si\s+(?:alguien|alguno|alguna|quieren|te)\s+(?:(?:esta\s+)?interesad[oa]s?|interesa)|si quieren|para\s+los\s+interesad[oa]s?|interested\??|if\s+you(?:'re| are)? interested|anyone interested|quien quiere ver|who wants to see)\b/u;
const QUALIFIED_MAKER_OFFER_PATTERN =
  /\b(?:hago|hacemos|realizo|realizamos|puedo hacer|make|can make|i make|i do)\b.{0,45}\b(?:personalizad[oa]s?|customs?|privad[oa]s?|paid|por dinero|por pago|por encargo)\b/u;
const SELLER_HANDOFF_PATTERN =
  /\b(?:te paso|te puedo pasar|les puedo pasar|puedo pasarles|te envio|te puedo enviar|send you|i can send you)\b.{0,35}\b(?:mi|mis|my|precio|precios|price|prices|menu|catalogo|catalog)\b/u;
const PRICE_OFFER_PATTERN =
  /\b(?:mis videos?|my videos?)\b.{0,30}\b(?:cuestan|valen|cost|costs)\b|\b(?:promotion|promocion|promo)\b.{0,70}\b(?:pack|contenido|content|video|fotos?|photos?).{0,50}\b(?:usd|dolares|precio|price|dm|reserva|book)\b/u;
const IMPLICIT_SOLICITATION_PATTERN =
  /\b(?:si\s+(?:alguien|alguno|alguna|quieren|te)\s+(?:(?:esta\s+)?interesad[oa]s?|interesa).{0,50}(?:me escribe|me escriben|escriban|escribeme|dm|message me)|si quieren.{0,35}(?:me escriben|escriban|escribeme|dm)|interesados?\s+(?:escriban|escribeme|al dm|por dm)|interested.{0,25}(?:dm|message me)|quien quiere ver.{0,30}lo que tengo)\b/u;
const FIRST_PERSON_SELLING_INTENT_PATTERN =
  /\b(?:vendo|vendiendo|vender|ofrezco|ofreciendo|acepto|aceptando|i sell|i'm selling|i am selling|i also sell|i offer|i'm offering|i am offering|i also offer)\b/u;
const SEEKING_OPPOSITE_SIDES_PATTERN =
  /\b(?:busco|buscando|looking for)\b.{0,45}\b(?:clientes?|comprador(?:es)?|buyers?|customers?)\b.{0,60}\b(?:tambien|y|and)\b.{0,25}\b(?:busco|buscando|looking for)\b.{0,35}\b(?:chica|creadora|alguien|girl|creator)\b/u;
const SEEKING_PROVIDER_PATTERN =
  /\b(?:busco|buscando|looking for)\b.{0,45}\b(?:una chica|chica|creadora|alguien|a girl|girl|creator|someone)\b/u;
const WEAK_COMMERCIAL_CONTEXT_PATTERN =
  /\b(?:info|paypal|reservas?|cuanto|how much|private call|message me|dm me|busco una chica|buscando una chica|busco alguien|buscando a alguien|looking for a girl|estoy buscando|tengo algo para|i have something for)\b/u;
const NON_PROMOTIONAL_CHAT_PATTERN =
  /\b(?:publican|publicaron|publico|subio|salio bien|parece viejo|me parece caro|precio.*caro|ese precio|too high|seems too high|a question about|disponible.*(?:hablar|conversar|reunion|meeting|talk)|available.*(?:talk|meeting)|para conversar|de la entrada|of the ticket|price.*(?:ticket|entry)|content.*(?:channel|class)|menu.*(?:tiene|con).*precios nuevos|articulo.*explica)\b/u;

export function detectPromotion(
  text: string,
  dictionary: string[],
  options: { verified?: boolean } = {},
): PromotionDetection {
  const normalized = normalizeFilterTerm(text);
  const matches = unique(
    dictionary.filter((term) => term && containsTerm(normalized, term)),
  );
  const hasLink = LINK_PATTERN.test(text);
  const hasRelevantObject = COMMERCIAL_OBJECT_FOR_OFFER.test(normalized);
  const hasNeutralContext = NEUTRAL_CONTEXT_PATTERN.test(normalized);
  const hasSexualContext = SEXUAL_CONTEXT_PATTERN.test(normalized);
  const clauses = text
    .split(/[.!?;\n]+|\b(?:but|pero|although|sin embargo)\b/iu)
    .map(normalizeFilterTerm);
  const buyingSignals = collectSignals(normalized, BUYING_PATTERNS);
  const contactSignals = CONTACT_PATTERN.test(normalized)
    ? collectSignals(normalized, CONTACT_SIGNAL_EXAMPLES.map((phrase) => [
        new RegExp(`\\b${normalizeFilterTerm(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "u"),
        phrase,
      ] as const))
    : [];
  const commercialSignals = unique([
    ...matches.map(normalizeFilterTerm),
    ...(hasRelevantObject ? ["producto o servicio"] : []),
  ]);
  const sellingPatterns = collectSignals(normalized, EXPLICIT_SELLING_PATTERNS);
  const hasNegatedSelling = NEGATED_SELLING_PATTERN.test(normalized) ||
    NEGATED_OFFER_CONTEXT.test(normalized);
  const seekingBuyer = SEEKING_BUYERS_PATTERN.test(normalized);
  const buyingDirection = BUYER_SEEKING_SELLER_PATTERN.test(normalized);
  const ambiguousPackProvider =
    AMBIGUOUS_PACK_PROVIDER_PATTERN.test(normalized) &&
    !/\bme\s+venda\b/u.test(normalized);
  const hasDirectOffer = clauses.some((clause) =>
    (STRONG_SELLING_CLAUSE_PATTERN.test(clause) ||
      QUALIFIED_MAKER_OFFER_PATTERN.test(clause)) &&
    SELLING_OBJECT_PATTERN.test(clause) &&
    !/\b(?:do you|can you)\s+(?:make|do|offer|sell)\b/u.test(clause) &&
    !BUYER_SEEKING_SELLER_PATTERN.test(clause),
  ) &&
    !buyingDirection &&
    !/\b(?:quieres|do you want to)\s+vender\b/u.test(normalized);
  const ownedQualifiedOffer =
    /\b(?:tengo|mi|mis|i have|my)\b/u.test(normalized) &&
    /\b(?:nuevo|nueva|nuevos|nuevas|new|exclusivo|exclusiva|exclusivos|exclusivas|exclusive|premium|disponible|disponibles|available|privado|privada|private|personalizado|personalizada|custom|por encargo|a pedido)\b/u.test(normalized);
  const hasImplicitOffer =
    (
      (hasRelevantObject && seekingBuyer && (hasSexualContext || /\b(?:servicio|servicios|service|services)\b/u.test(normalized))) ||
      (hasRelevantObject && ownedQualifiedOffer) ||
      (/\b(?:tengo|mi|mis|i have|my)\b/u.test(normalized) &&
        (CTA_PATTERN.test(normalized) || AUDIENCE_INVITATION_PATTERN.test(normalized) || /\b(?:message me|dm me|interested)\b/u.test(normalized))) ||
      (/\b(?:hago|puedo hacer|make|can make)\b/u.test(normalized) && /\b(?:personalizado|personalizada|custom)\b/u.test(normalized)) ||
      /\b(?:taking custom orders|accepting custom requests|my menu|prices in dm|menu in dm|content available, dm|i sell|i'm selling|i am selling|i offer|i'm offering|i am offering|i make|i do customs|i take custom|i accept custom|my content is available|new content available|i take commissions|i accept commissions)\b/u.test(normalized) ||
      (hasRelevantObject && /\b(?:por encargo|a pedido|on request|by request)\b/u.test(normalized)) ||
      SELLER_HANDOFF_PATTERN.test(normalized) ||
      PRICE_OFFER_PATTERN.test(normalized) ||
      /\b(?:content|packs?|videos?|photos?|contenido|fotos?)\s+(?:available|disponible|disponibles|por privado|al privado).{0,25}\b(?:dm|escribeme|message me|inbox|privado|private)\b/u.test(normalized) ||
      /\b(?:custom orders available|packs? disponibles? por privado|contenido disponible.{0,20}escribeme)\b/u.test(normalized) ||
      IMPLICIT_SOLICITATION_PATTERN.test(normalized) ||
      (AUDIENCE_INVITATION_PATTERN.test(normalized) &&
        (hasRelevantObject || CTA_PATTERN.test(normalized) || /\b(?:my|mi|mis|tengo|i have)\b/u.test(normalized))));
  const buyingQuestion = BUYING_QUESTION_PATTERN.test(normalized) ||
    (/\b(?:cuanto|que precio)\b/u.test(normalized) && hasRelevantObject && !/\b(?:mañana|tomorrow)\b/u.test(normalized)) ||
    (/\b(?:precio|price)\b/u.test(normalized) && /\b(?:cu[aá]l es|what are|what is)\b/u.test(normalized));
  const sellingEvidence = hasDirectOffer || hasImplicitOffer;
  const buyingEvidence = (hasRelevantObject &&
    BUYING_ACTION_PATTERN.test(normalized) &&
    !seekingBuyer &&
    !ambiguousPackProvider &&
    !/\b(?:quiero|quieres)\s+vender\b/u.test(normalized) &&
    !/\b(?:quiero|quieres)\s+hablar en privado\b/u.test(normalized)) ||
    buyingQuestion ||
    (/\b(?:busco|buscando|looking for)\s+(?:(?:una?|a)\s+)?(?:chica|girl|creator|creadora)\b/u.test(normalized) &&
      !ambiguousPackProvider &&
      !/\b(?:para hablar|to talk)\b/u.test(normalized));
  const weakOwnerAlongsideQuestion =
    /\b(?:tengo|i have)\b/u.test(normalized) &&
    buyingEvidence &&
    !sellingEvidence &&
    (/\b(?:que precio tienes|cuanto cobras|how much do you charge)\b/u.test(normalized) ||
      buyingDirection ||
      SEEKING_PROVIDER_PATTERN.test(normalized));
  const negativeOffer = hasNegatedSelling && !sellingEvidence;
  const contradiction =
    (sellingEvidence && buyingEvidence) ||
    weakOwnerAlongsideQuestion ||
    (hasDirectOffer && seekingBuyer) ||
    (seekingBuyer && buyingQuestion) ||
    (buyingEvidence && FIRST_PERSON_SELLING_INTENT_PATTERN.test(normalized)) ||
    SEEKING_OPPOSITE_SIDES_PATTERN.test(normalized);

  const signals = new Set<PromotionSignal>();
  if (/\b(?:vendo|vendemos|vender|ofrezco|ofrecemos|a la venta|selling)\b/u.test(normalized)) signals.add("sale");
  if (/\b(?:pago|pagos|pagar|cobro|cobrar|transferencia|paypal|binance|usdt|usd|dolares|price|prices)\b/u.test(normalized)) signals.add("payment");
  if (CTA_PATTERN.test(normalized)) signals.add("contact");
  if (hasSexualContext) signals.add("adult");
  if (/\b(?:promocion|oferta|descuento|promotion|offer)\b/u.test(normalized)) signals.add("offer");
  if (hasLink) signals.add("link");

  let intent: PromotionIntent;
  let confidence: number;
  let reason: string;

  if (contradiction) {
    intent = "AMBIGUOUS";
    confidence = 0.35;
    reason = "Se detectaron intenciones de compra y oferta incompatibles.";
  } else if (
    hasNeutralContext ||
    (NON_PROMOTIONAL_CHAT_PATTERN.test(normalized) &&
      !hasDirectOffer)
  ) {
    intent = "NEUTRAL";
    confidence = 0.94;
    reason = "El contexto identifica una conversación o actividad no promocional.";
  } else if (sellingEvidence && !negativeOffer) {
    intent = "SELLING";
    confidence = hasDirectOffer ? 0.96 : ownedQualifiedOffer ? 0.91 : 0.86;
    reason = hasDirectOffer
      ? "Se detectó una acción de oferta propia junto con un producto o servicio."
      : "Se detectó una oferta implícita dirigida a posibles clientes.";
  } else if (
    buyingEvidence ||
    (hasRelevantObject && buyingDirection && !ambiguousPackProvider)
  ) {
    intent = "BUYING";
    confidence = 0.92;
    reason = "La estructura expresa búsqueda, pregunta o intención de compra.";
  } else if (
    negativeOffer ||
    (!hasRelevantObject &&
      !CONTACT_PATTERN.test(normalized) &&
      !CTA_PATTERN.test(normalized) &&
      !WEAK_COMMERCIAL_CONTEXT_PATTERN.test(normalized) &&
      !hasLink) ||
    (CONVERSATIONAL_ACTION_PATTERN.test(normalized) && !sellingEvidence) ||
    (NON_PROMOTIONAL_CHAT_PATTERN.test(normalized) && !sellingEvidence)
  ) {
    intent = "NEUTRAL";
    confidence = 0.94;
    reason = "El mensaje es conversacional o no constituye una oferta promocional.";
  } else if (
    hasRelevantObject ||
    CONTACT_PATTERN.test(normalized) ||
    hasLink ||
    WEAK_COMMERCIAL_CONTEXT_PATTERN.test(normalized)
  ) {
    intent = "AMBIGUOUS";
    confidence = hasRelevantObject && CONTACT_PATTERN.test(normalized) ? 0.55 : 0.4;
    reason = "Hay señales comerciales, pero no se identifica con claridad quién compra o vende.";
  } else {
    intent = "NEUTRAL";
    confidence = 0.96;
    reason = "No se encontraron señales comerciales relevantes.";
  }

  const sellingSignals = unique([
    ...sellingPatterns,
    ...(seekingBuyer ? ["busqueda de compradores"] : []),
    ...(hasImplicitOffer ? ["oferta implicita"] : []),
  ]);
  return {
    intent,
    confidence,
    buyingSignals,
    sellingSignals,
    contactSignals,
    commercialSignals,
    matches,
    signals,
    hasLink,
    shouldModerate: intent === "SELLING" && options.verified !== true,
    reason,
  };
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "Alta";
  if (confidence >= 0.55) return "Media";
  return "Baja";
}
