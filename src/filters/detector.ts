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
  "busco alguien que venda",
  "quiero comprar",
  "quien vende",
  "alguien selling",
  "looking for someone who sells",
  "where can I buy",
  "cuanto cuesta",
] as const;

export const SELLING_SIGNAL_EXAMPLES = [
  "vendo",
  "ofrezco",
  "hago videos para clientes",
  "acepto pedidos",
  "busco comprador",
  "mis packs a la venta",
  "I sell",
  "I take commissions",
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
  "por privado",
  "message me",
  "send me a message",
] as const;

const COMMERCIAL_OBJECT_PATTERN =
  /\b(?:contenido|content|material|packs?|paquetes?|bundles?|sets?|catalogo|menu|galerias?|galleries|clips?|fotos?|photos?|pics?|videos?|albums?|nudes?|sexting|videollamadas?|video calls?|llamadas?|calls?|servicios?|services?|pedidos?|orders?|comisiones?|commissions?|customs?|personalizad[oa]s?)\b/u;
const CONTACT_PATTERN =
  /\b(?:dm|inbox|directo|escribeme|hablame|contactame|interesados?|por privado|al privado|habla conmigo|mandame mensaje|mensajeame|message me|send me a message|private message|details by dm|dm me)\b/u;
const LINK_PATTERN = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/iu;

const AUTHOR_SELLING_ACTION =
  /\b(?:(?:yo|nosotros|nosotras)\s+)?(?:vendo|vendemos|ofrezco|ofrecemos|hago|hacemos|realizo|realizamos|preparo|preparamos|creo|creamos|acepto|aceptamos|tomo|tomamos|estoy\s+(?:tomando|ofreciendo)|promociono|promocionando)\b|\b(?:quiero|voy\s+a|planeo)\s+vender\b|\b(?:i|we)\s+(?:(?:am|are)\s+)?(?:(?:also|sometimes|still|now)\s+)?(?:selling|sell|offer|make|create|do|accept|take|prepare|commission)\b|\bi\s+(?:(?:might|may|could|would)\s+)?sell\b|\bi['’]?m\s+(?:selling|offering|taking|accepting)\b|\b(?:taking|accepting|offering)\s+(?:custom\s+)?(?:orders|requests|commissions)\b|\bselling\s+(?:my|our)\b/u;
const NEGATED_SELLING_ACTION =
  /\b(?:no|nunca|jamas|not|never|don['’]?t|do\s+not|doesn['’]?t|does\s+not|isn['’]?t|is\s+not|aren['’]?t|are\s+not|am\s+not)\b.{0,32}\b(?:vendo|vendemos|vender|ofrezco|ofrecemos|ofrecer|hago|hacemos|hacer|realizo|realizamos|acepto|tomando|selling|sell|offer|offering|make|making|accept|taking)\b/u;
const OWNED_OBJECT_PATTERN =
  /\b(?:tengo|mi|mis|nuestro|nuestra|nuestros|nuestras|i\s+have|i['’]?ve\s+got|my|our)\b.{0,45}\b(?:contenido|content|material|packs?|paquetes?|bundles?|sets?|catalogo|menu|galerias?|galleries|clips?|fotos?|photos?|pics?|videos?|albums?|nudes?|sexting|videollamadas?|llamadas?|servicios?|services?|pedidos?|orders?|comisiones?|commissions?|customs?)\b/u;
const OFFER_DESCRIPTOR_PATTERN =
  /\b(?:nuevo|nueva|nuevos|nuevas|new|exclusive|exclusivo|exclusiva|disponible|available|por\s+encargo|for\s+sale|a\s+la\s+venta|sale|descuento|discount|precio|prices?|tarifa|rates?|usd|eur|euros?|dolares?|dollars?)\b/u;
const SELLING_BUYER_AUDIENCE_PATTERN =
  /\b(?:busco|buscando|buscamos|looking\s+for)\s+(?:(?:both|ambos)\s+)?(?:a\s+)?(?:clientes?|clientas?|buyers?|comprador(?:es)?|customers?|interesad[oa]s?|people\s+interested|interested\s+people)\b/u;
const OWNED_SALE_PATTERN =
  /\b(?:mis?|nuestros?|nuestras?|my|our)\b.{0,45}\b(?:a\s+la\s+venta|for\s+sale|available|disponible|discount|descuento|precios?|prices?|usd|eur|euros?|dolares?|dollars?)\b/u;
const STRONG_OFFER_CONTEXT_PATTERN =
  /\b(?:para\s+quien\s+quiera|for\s+anyone\s+interested|if\s+you['’]?re\s+interested|interesados?\s+(?:al|por)|details?\s+(?:by|via)|detalles?\s+por|solo\s+gente\s+seria|serious\s+buyers)\b/u;

const BUYING_ACTION_PATTERN =
  /\b(?:busco|buscando|quiero\s+comprar|quisiera\s+comprar|necesito\s+comprar|me\s+interesa\s+comprar|compro|quiero\s+(?:ver|conseguir|pedir)|necesito\s+(?:conseguir|ver|pedir)|looking\s+for|i\s+(?:(?:also|might|still)\s+)?want\s+to\s+buy|i\s+(?:(?:am|might|also|still)\s+){0,2}looking\s+to\s+buy|can\s+i\s+buy|i['’]?m\s+looking\s+for|where\s+can\s+i\s+buy|donde\s+(?:puedo\s+)?comprar|donde\s+consigo|cuanto\s+cuesta|cuanto\s+sale|how\s+much\s+(?:does\s+it\s+)?cost|what\s+are\s+your\s+rates?)\b/u;
const BUYER_SEEKING_SELLER_PATTERN =
  /\b(?:busco|buscando|looking\s+(?:for|4)|need)\s+(?:a|un|una)?\s*(?:vendedor(?:es)?|seller(?:s)?)\b|\b(?:and|y)\s+(?:a|un|una)?\s*(?:vendedor(?:es)?|seller(?:s)?)\b|\b(?:busco|buscando|looking\s+(?:for|4))\b.{0,65}\b(?:alguien|alguna?\s+persona|una?\s+chica|a\s+girl|someone|somebody|a\s+creator|a\s+seller)\b.{0,45}\b(?:que\s+)?(?:venda|vendan|ofrezca|ofrezcan|haga|hagan|vende|selling|sells?|offers?|makes?|does)\b|\b(?:alguien|someone|anyone|anybody)\s+(?:who\s+|que\s+)?(?:vende|venda|vendan|sells?|offers?|ofrece|takes?|acepta)\b|\b(?:anyone|anybody|any1|who|where\s+can\s+i)\b.{0,35}\b(?:selling|sell|sells|offering|offers|making|does|takes)\b|\b(?:do\s+you|does\s+anyone|does\s+anybody)\s+(?:sell|offer|have|make)\b|\b(?:who|quien)\s+(?:takes?|accepts?|acepta|ofrece|vende)\b.{0,40}\b(?:orders?|pedidos?|customs?)\b|\balguna\s+chica\b.{0,40}\b(?:vende|venden|ofrece|ofrecen|hace|hacen)\b|\balguien\s+(?:acepta|toma)\s+pedidos?\b|\b(?:quien(?:es)?|alguien|alguna?)\s+(?:vende|venden|ofrece|ofrecen|hace|hacen)\b|\b(?:vendes|ofreces|tienes|haces)\b/u;
const BUYING_OBJECT_REQUEST_PATTERN =
  /\b(?:busco|buscando|quiero|quisiera|necesito|looking\s+(?:for|4)|i\s+want|i\s+need|anyone\s+have|do\s+you\s+have)\b.{0,55}\b(?:contenido|content|material|packs?|paquetes?|bundles?|sets?|catalogo|menu|galerias?|galleries|clips?|fotos?|photos?|pics?|videos?|albums?|nudes?|customs?|videollamadas?|video\s+calls?)\b|\b(?:can\s+(?:someone|anyone)|could\s+someone)\s+(?:send|share)\s+me\b.{0,55}\b(?:contenido|content|material|packs?|catalogo|menu|galerias?|galleries|clips?|fotos?|photos?|pics?|videos?|albums?|customs?)\b|\b(?:can|could)\s+(?:someone|anyone)\s+share\s+(?:their|the)\b.{0,55}\b(?:contenido|content|material|packs?|catalogo|menu|galerias?|galleries|clips?|fotos?|photos?|pics?|videos?|albums?|customs?)\b|\b(?:who\s+sells|anyone\s+selling|anybody\s+selling|any1\s+selling|who\s+offers|who\s+makes)\b.{0,45}\b(?:contenido|content|material|packs?|bundles?|sets?|galerias?|galleries|clips?|fotos?|photos?|videos?|albums?|customs?)\b/u;
const BUYING_PRICE_QUESTION_PATTERN =
  /\b(?:cuanto\s+(?:cuesta|sale|cobras)|que\s+precio\s+(?:tiene|tienen)|how\s+much|what\s+do\s+you\s+charge|what\s+are\s+your\s+prices)\b/u;
const BUYING_SIGNAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [BUYER_SEEKING_SELLER_PATTERN, "busqueda de vendedor"],
  [BUYING_ACTION_PATTERN, "intencion de compra"],
  [BUYING_OBJECT_REQUEST_PATTERN, "busqueda de producto o servicio"],
  [BUYING_PRICE_QUESTION_PATTERN, "pregunta de precio"],
];

const THIRD_PERSON_SELLER_PATTERN =
  /\b(?:(?:mi|mis|su|sus|my|his|her|their)\b.{0,35}\b(?:amig[oa]|friend|pareja|sister|hermana|conocid[oa]|creator|creadora|chica|girl|vendedor|seller)|conozco\s+(?:a\s+)?(?:una?\s+)?(?:chica|persona|creadora)|i\s+know\s+(?:a\s+)?(?:girl|creator|seller))\b.{0,45}\b(?:vende|venden|vendia|sells?|selling|ofrece|ofrecen|offers?|hace|hacen|makes?)\b/u;
const NEUTRAL_CONTEXT_PATTERN =
  /\b(?:work\s+schedule|shared\s+calendar|phone|telefono|available\s+in\s+my\s+country|internet\s+(?:signal|service)|senal\s+de\s+internet|mi\s+zona|my\s+area|my\s+country|university|universidad|escuela|school|homework|tarea|class|clase|presentation|presentacion|work\s+presentation|proyecto|project|avatar|video\s+game|videogame|minecraft|bank|banco|monthly\s+statement|estado\s+de\s+cuenta|restaurant|restaurante|store|tienda|vacation|vacaciones|viaje|my\s+mom|my\s+mother|mi\s+mama|mi\s+madre|family|familia|familiar|youtube|pelicula|movie|trabajo|job\s+search|looking\s+for\s+a\s+job|miembros?|members?|curso|course|grupo|group|paquete\s+.*\b(?:llego|arrived)\b|(?:llego|arrived)\s+(?:incompleto|incomplete|damaged)|\b(?:bought|purchased|compre)\b)\b/u;

export function normalizeFilterTerm(value: string): string {
  return value
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

export function detectPromotion(
  text: string,
  dictionary: string[],
  options: { verified?: boolean } = {},
): PromotionDetection {
  const normalized = normalizeFilterTerm(text);
  const matches = unique(
    dictionary.filter((term) => term && containsTerm(normalized, term)),
  );
  const hasCommercialObject = COMMERCIAL_OBJECT_PATTERN.test(normalized);
  const commercialSignals = unique([
    ...matches.map(normalizeFilterTerm),
    ...(hasCommercialObject ? ["producto o servicio"] : []),
  ]);
  const hasCommercialContext = hasCommercialObject || matches.length > 0;
  const clauses = normalized
    .split(/[,.!?;\n]+|\b(?:pero|but|although|however|sin embargo)\b/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const buyingSignals = collectSignals(normalized, BUYING_SIGNAL_PATTERNS);
  const buyerSeekingSeller = BUYER_SEEKING_SELLER_PATTERN.test(normalized);
  const seeksOwnBuyers = clauses.some((clause) =>
    SELLING_BUYER_AUDIENCE_PATTERN.test(clause),
  );
  const independentBuyingClause = clauses.some((clause) =>
    (!SELLING_BUYER_AUDIENCE_PATTERN.test(clause) ||
      /\b(?:quiero|quisiera|necesito)\s+comprar|\bcompro\b|\bi\s+(?:want|need)\s+to\s+buy\b/u.test(
        clause,
      )) &&
    (!AUTHOR_SELLING_ACTION.test(clause) ||
      /\b(?:quiero|quisiera|necesito)\s+comprar|\bcompro\b|\bi\s+(?:want|need)\s+to\s+buy\b/u.test(
        clause,
      ) ||
      !hasCommercialObject) &&
    (BUYING_OBJECT_REQUEST_PATTERN.test(clause) ||
      (BUYING_ACTION_PATTERN.test(clause) &&
        (!BUYING_PRICE_QUESTION_PATTERN.test(clause) ||
          hasCommercialObject)) ||
      (BUYING_PRICE_QUESTION_PATTERN.test(clause) && hasCommercialObject)),
  );

  const contactSignals = CONTACT_PATTERN.test(normalized)
    ? CONTACT_SIGNAL_EXAMPLES.filter((phrase) =>
        containsTerm(normalized, phrase),
      )
    : [];
  const hasContactCallToAction = contactSignals.length > 0;
  const hasLink = LINK_PATTERN.test(text);
  const buyerIntent =
    (hasCommercialContext ||
      (hasLink && buyerSeekingSeller) ||
      (seeksOwnBuyers && buyerSeekingSeller)) &&
    (buyerSeekingSeller || independentBuyingClause);
  const hasNegatedSeller = clauses.some((clause) =>
    NEGATED_SELLING_ACTION.test(clause),
  );
  const neutralContext = NEUTRAL_CONTEXT_PATTERN.test(normalized);
  const thirdPersonSeller = THIRD_PERSON_SELLER_PATTERN.test(normalized);

  const authorSellingClauses = clauses.filter((clause) => {
    if (NEGATED_SELLING_ACTION.test(clause)) return false;
    if (THIRD_PERSON_SELLER_PATTERN.test(clause)) return false;

    const authorAction = AUTHOR_SELLING_ACTION.test(clause);
    const seeksBuyers = SELLING_BUYER_AUDIENCE_PATTERN.test(clause);
    const ownedOffer =
      OWNED_OBJECT_PATTERN.test(clause) &&
      (OFFER_DESCRIPTOR_PATTERN.test(clause) ||
        OWNED_SALE_PATTERN.test(clause) ||
        STRONG_OFFER_CONTEXT_PATTERN.test(clause) ||
        hasContactCallToAction);
    const advertisedObject =
      hasCommercialObject &&
      (STRONG_OFFER_CONTEXT_PATTERN.test(clause) ||
        (/\b(?:nuevo|nueva|nuevos|nuevas|new|fresh|exclusive|exclusivo|exclusiva)\b/u.test(
          clause,
        ) &&
          /\b(?:disponible|available)\b/u.test(clause)));
    return (
      (authorAction && hasCommercialObject) ||
      (seeksBuyers &&
        (hasCommercialObject ||
          OWNED_OBJECT_PATTERN.test(clause) ||
          buyerSeekingSeller)) ||
      ownedOffer ||
      advertisedObject
    );
  });

  const authorSelling = authorSellingClauses.length > 0 && !neutralContext;
  const sellingSignals = authorSelling
    ? unique([
        ...(authorSellingClauses.some((clause) =>
          AUTHOR_SELLING_ACTION.test(clause),
        )
          ? ["oferta propia en primera persona"]
          : []),
        ...(authorSellingClauses.some((clause) =>
          SELLING_BUYER_AUDIENCE_PATTERN.test(clause),
        )
          ? ["busqueda de compradores"]
          : []),
        ...(authorSellingClauses.some((clause) =>
          OWNED_OBJECT_PATTERN.test(clause),
        )
          ? ["producto propio con señal de oferta"]
          : []),
        ...(hasContactCallToAction ? contactSignals : []),
      ])
    : [];
  const activeBuyingSignals = buyerIntent ? buyingSignals : [];

  const signals = new Set<PromotionSignal>();
  if (authorSelling) signals.add("sale");
  if (/\b(?:pago|pagos|pagar|cobro|cobrar|transferencia|paypal|binance|usdt|usd|dolares|dollars|eur|euros)\b/u.test(normalized)) {
    signals.add("payment");
  }
  if (hasContactCallToAction) signals.add("contact");
  if (/\b(?:adultos|desnudos?|nudes?|sexting|contenido \+18|contenido 18\+)\b/u.test(normalized)) {
    signals.add("adult");
  }
  if (/\b(?:promocion|oferta|descuento|discount|for sale|a la venta)\b/u.test(normalized)) {
    signals.add("offer");
  }
  if (hasLink) signals.add("link");

  let intent: PromotionIntent;
  let confidence: number;
  let reason: string;

  if (authorSelling && buyerIntent) {
    intent = "AMBIGUOUS";
    confidence = 0.35;
    reason = "El mensaje combina una oferta atribuible al autor con una intención de compra.";
  } else if (authorSelling) {
    intent = "SELLING";
    confidence = authorSellingClauses.some((clause) =>
      AUTHOR_SELLING_ACTION.test(clause),
    )
      ? 0.94
      : 0.84;
    reason = "Se identifica una oferta del autor y un producto o servicio relacionado.";
  } else if (buyerIntent) {
    intent = "BUYING";
    confidence = 0.9;
    reason = "El autor busca comprar o pregunta por una oferta de otra persona.";
  } else if (neutralContext || thirdPersonSeller || hasNegatedSeller) {
    intent = "NEUTRAL";
    confidence = 0.92;
    reason = hasNegatedSeller
      ? "La acción de venta está negada y no hay una intención positiva de compra."
      : "El contexto describe una actividad cotidiana o una oferta atribuida a otra persona.";
  } else if (
    hasCommercialContext ||
    hasContactCallToAction ||
    hasLink ||
    /\b(?:vendes?|vend(?:e|es|en)|sell|selling|precio|price|customs?|ppv)\b/u.test(
      normalized,
    ) ||
    BUYING_PRICE_QUESTION_PATTERN.test(normalized)
  ) {
    intent = "AMBIGUOUS";
    confidence = 0.4;
    reason = "Hay señales comerciales, pero no se identifica con claridad quién compra o vende.";
  } else {
    intent = "NEUTRAL";
    confidence = 0.96;
    reason = "No se encontraron señales comerciales relevantes.";
  }

  const shouldModerate = intent === "SELLING" && options.verified !== true;
  return {
    intent,
    confidence,
    buyingSignals: activeBuyingSignals,
    sellingSignals,
    contactSignals,
    commercialSignals,
    matches,
    signals,
    hasLink,
    shouldModerate,
    reason,
  };
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "Alta";
  if (confidence >= 0.55) return "Media";
  return "Baja";
}
