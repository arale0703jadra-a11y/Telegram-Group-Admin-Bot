export type PromotionSignal =
  | "sale"
  | "payment"
  | "contact"
  | "adult"
  | "offer"
  | "link";

export interface PromotionDetection {
  matches: string[];
  signals: Set<PromotionSignal>;
  hasLink: boolean;
  clearlyPromotional: boolean;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(text: string, term: string): boolean {
  const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

export function detectPromotion(
  text: string,
  dictionary: string[],
): PromotionDetection {
  const normalized = normalize(text);
  const matches = dictionary.filter((term) => containsTerm(normalized, term));
  const signals = new Set<PromotionSignal>();
  const add = (terms: string[], signal: PromotionSignal) => {
    if (terms.some((term) => matches.includes(term))) signals.add(signal);
  };
  add(["vendo", "venta", "vender", "precio", "precios", "tarifa", "tarifas", "oferta", "descuento"], "sale");
  add(["pago", "pagos", "pagar", "cobro", "cobrar", "transferencia", "paypal", "binance", "usdt", "usd"], "payment");
  add(["dm", "inbox", "directo", "contactame", "escribeme", "hablame", "por privado", "interesados"], "contact");
  add(["contenido adulto", "adultos", "desnudos", "desnudo", "nudes", "nude", "sexting", "contenido +18", "contenido 18+"], "adult");
  add(["promocion", "promocion especial", "oferta", "descuento"], "offer");

  const hasLink = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/iu.test(text);
  if (hasLink) signals.add("link");
  const relatedSignals = [...signals].filter((signal) => signal !== "link");
  const clearlyPromotional =
    relatedSignals.length >= 2 ||
    (signals.has("payment") && signals.has("contact")) ||
    (signals.has("adult") && (signals.has("contact") || signals.has("payment")));

  return { matches, signals, hasLink, clearlyPromotional };
}
