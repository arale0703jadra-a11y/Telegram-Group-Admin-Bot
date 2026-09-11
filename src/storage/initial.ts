import type { AntiSpamConfig, GroupData, IllegalContentConfig, InactivityConfig, PromotionConfig } from "./types.js";

export const PROMOTION_DICTIONARY = [
  "vendo", "venta", "vender", "vendo contenido", "contenido",
  "contenido privado", "contenido exclusivo", "contenido premium",
  "contenido personalizado", "material", "material privado",
  "material exclusivo", "pack", "packs", "paquete", "catálogo",
  "catalogo", "menú", "menu", "disponible", "disponibilidad",
  "precio", "precios", "tarifa", "tarifas", "cuesta", "cuánto",
  "cuanto", "pago", "pagos", "pagar", "cobro", "cobrar",
  "transferencia", "paypal", "binance", "usdt", "dólares", "dolares",
  "usd", "barato", "privado", "por privado", "escríbeme", "escribeme",
  "háblame", "hablame", "dm", "inbox", "directo", "contáctame",
  "contactame", "interesados", "interesada", "información", "informacion",
  "info", "consulta", "reservas", "reservar", "fotos", "fotos privadas",
  "videos", "videos privados", "álbum", "album", "contenido +18",
  "contenido 18+", "contenido adulto", "adultos", "desnudos", "desnudo",
  "nudes", "nude", "pic", "pics", "video privado", "foto privada",
  "personalizado", "personalizada", "llamada", "videollamada",
  "llamada privada", "videollamada privada", "sesión", "sesion",
  "sesión privada", "atención privada", "atencion privada", "novia virtual",
  "compañía virtual", "compania virtual", "chat privado", "chat exclusivo",
  "sexting", "promoción", "promocion", "oferta", "descuento",
  "promoción especial",
];

export const DEFAULT_PROMOTION_MESSAGES = {
  promotionWarning: "⚠️ Promoción no autorizada",
  promotionRemoved:
    "Tu mensaje fue eliminado por posible promoción no autorizada.",
  promotionMuted: "Has sido silenciado temporalmente por promoción no autorizada.",
  linkWarning: "⚠️ Los enlaces promocionales no están permitidos.",
  verificationRequired:
    "Las promociones están permitidas únicamente para creadoras verificadas.",
};

export function initialPromotionConfig(): PromotionConfig {
  return {
    enabled: true,
    dictionary: [...PROMOTION_DICTIONARY],
    verificationContacts: ["@DanielRF25", "@ChrisUzca2406"],
    verifiedUsers: {},
    recurrenceMuteMinutes: [15, 60, 240, 1440],
    messages: { ...DEFAULT_PROMOTION_MESSAGES },
    infractions: {},
  };
}

export const ILLEGAL_PROTECTED_CATEGORIES = [
  "Explotación sexual de menores",
  "Abuso sexual infantil",
  "Grooming/captación",
  "Zoofilia/bestialidad",
  "Intercambio/solicitud de material ilegal",
  "Venta de material ilegal",
  "Otras señales de contenido sexual ilegal",
];

export function initialIllegalContentConfig(): IllegalContentConfig {
  return {
    enabled: true,
    customTerms: [],
    suspiciousDeletes: true,
    highConfidenceBan: true,
    highConfidenceDelete: true,
    events: 0,
  };
}

export function initialAntiSpamConfig(): AntiSpamConfig {
  return {
    enabled: true,
    maxMentionsPerMessage: 5,
    blockLinks: true,
    detectRepeatedMessages: true,
    detectAutomatedBehavior: true,
    infractions: {},
  };
}

export function initialInactivityConfig(): InactivityConfig {
  return { enabled: false, inactivityDays: 30 };
}

/**
 * Estado inicial de un grupo recién registrado.
 * Cada grupo (chat_id) parte de estos valores por defecto.
 */
export function initialGroupData(): GroupData {
  return {
    warnings: {},
    warnLimit: 3,
    warnAction: "mute",
    mutedUsers: {},
    bannedUsers: {},
    recentMessages: [],
    indexedUsers: {},
    events: [],
    welcome: { enabled: true, message: "" },
    promotion: initialPromotionConfig(),
    illegalContent: initialIllegalContentConfig(),
    antiSpam: initialAntiSpamConfig(),
    inactivity: initialInactivityConfig(),
  };
}