import type { GroupData, PromotionConfig } from "./types.js";

export const PROMOTION_DICTIONARY = [
  "vendo", "venta", "vender", "vendo contenido", "contenido",
  "contenido privado", "contenido exclusivo", "contenido premium",
  "contenido personalizado", "material", "material privado",
  "material exclusivo", "pack", "packs", "paquete", "catalogo",
  "menu", "disponible", "disponibilidad", "precio", "precios",
  "tarifa", "tarifas", "cuesta", "cuanto", "pago", "pagos", "pagar",
  "cobro", "cobrar", "transferencia", "paypal", "binance", "usdt",
  "dolares", "usd", "barato", "privado", "por privado", "escribeme",
  "hablame", "dm", "inbox", "directo", "contactame", "interesados",
  "interesada", "informacion", "info", "consulta", "reservas",
  "reservar", "fotos", "fotos privadas", "videos", "videos privados",
  "album", "contenido +18", "contenido 18+", "contenido adulto",
  "adultos", "desnudos", "desnudo", "nudes", "nude", "pic", "pics",
  "video privado", "foto privada", "personalizado", "personalizada",
  "llamada", "videollamada", "llamada privada", "videollamada privada",
  "sesion", "sesion privada", "atencion privada", "novia virtual",
  "compania virtual", "chat privado", "chat exclusivo", "sexting",
  "promocion", "oferta", "descuento", "promocion especial",
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
  };
}