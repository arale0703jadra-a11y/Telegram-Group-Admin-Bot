import type {
  IllegalConfidence,
  IllegalRiskThresholds,
} from "../storage/types.js";
import { normalizeFilterTerm } from "./detector.js";

export type IllegalCategory =
  | "minor-exploitation"
  | "child-abuse"
  | "grooming"
  | "bestiality"
  | "illegal-exchange"
  | "illegal-sale"
  | "other-illegal-sexual";

export interface IllegalDetection {
  category?: IllegalCategory;
  confidence: IllegalConfidence;
  risk: "low" | "medium" | "high";
  intent:
    | "offer"
    | "sale"
    | "exchange"
    | "request"
    | "distribution"
    | "promotion"
    | "grooming"
    | "private-contact"
    | "informational"
    | "none";
  normalizationApplied: boolean;
  explicitIntent: boolean;
  signals: string[];
  critical: boolean;
  /** La detección es ambigua: conviene revisión humana antes de sancionar. */
  needsReview: boolean;
  reason: string;
}

/** Frases de referencia que solo adquieren riesgo alto con intención contextual. */
const EXPLICIT_CRITICAL_PHRASES: Array<{
  phrase: string;
  category: IllegalCategory;
}> = [
  { phrase: "abuso sexual infantil", category: "child-abuse" },
  { phrase: "abuso infantil", category: "child-abuse" },
  { phrase: "material de abuso infantil", category: "child-abuse" },
  { phrase: "material infantil ilegal", category: "child-abuse" },
  { phrase: "pornografia infantil", category: "child-abuse" },
  { phrase: "porno infantil", category: "child-abuse" },
  { phrase: "pornografia de menores", category: "minor-exploitation" },
  { phrase: "explotacion sexual de menores", category: "minor-exploitation" },
  { phrase: "explotacion sexual infantil", category: "minor-exploitation" },
  { phrase: "explotacion de menores", category: "minor-exploitation" },
  { phrase: "explotacion infantil", category: "minor-exploitation" },
  { phrase: "grooming", category: "grooming" },
  { phrase: "captacion de menores", category: "grooming" },
  { phrase: "captacion sexual de menores", category: "grooming" },
  { phrase: "contacto sexual con menores", category: "grooming" },
  { phrase: "zoofilia", category: "bestiality" },
  { phrase: "bestialidad", category: "bestiality" },
  { phrase: "sexo con animales", category: "bestiality" },
];

/**
 * Términos AMBIGUOS que NO deben sancionarse por sí solos: "cp" puede ser
 * "control panel" u otro significado; "zoo" un zoológico; "violación" puede
 * ser de reglas o de privacidad. Solo cuentan como señal fuerte cuando el
 * mensaje traemás contexto de edad y/o sexual/de intercambio.
 */
const AMBIGUOUS_TERMS: Array<{ term: string; category: IllegalCategory }> = [
  { term: "cp", category: "other-illegal-sexual" },
  { term: "zoo", category: "bestiality" },
  { term: "violacion", category: "other-illegal-sexual" },
];

const CATEGORY_TERMS: Record<IllegalCategory, string[]> = {
  "minor-exploitation": [
    "explotacion de menores",
    "explotacion sexual de menores",
    "pornografia de menores",
    "menor sexual",
    "abuso de menores",
  ],
  "child-abuse": [
    "abuso sexual infantil",
    "abuso infantil",
    "material de abuso infantil",
    "material infantil ilegal",
    "pornografia infantil",
  ],
  grooming: [
    "grooming",
    "captacion de menores",
    "captacion sexual de menores",
    "contacto sexual con menores",
  ],
  bestiality: ["zoofilia", "bestialidad", "sexo con animales"],
  "illegal-exchange": [
    "material ilegal",
    "intercambio ilegal",
    "contenido ilegal",
    "material sexual ilegal",
  ],
  "illegal-sale": [
    "venta de material ilegal",
    "material prohibido",
    "vendo material ilegal",
    "compro material ilegal",
  ],
  "other-illegal-sexual": [
    "contenido sexual ilegal",
    "intercambio sexual ilegal",
    "solicitud sexual ilegal",
    "abuso sexual",
    "explotacion sexual",
  ],
};

const AGE_TERMS = [
  "menor",
  "menores",
  "infantil",
  "adolescente",
  "nino",
  "nina",
];
const ACTION_TERMS = [
  "busco",
  "buscando",
  "vendo",
  "venta",
  "intercambio",
  "compartir",
  "envio",
  "enviar",
  "solicito",
  "solicitud",
  "contacto",
];
const SEXUAL_CONTEXT_TERMS = [
  "sexual",
  "sexo",
  "pornografia",
  "pornografico",
  "desnudo",
  "desnudos",
  "material",
  "video",
  "fotos",
  "imagenes",
];
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ԛ: "q",
  һ: "h",
  ӏ: "l",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "y",
  χ: "x",
};

const INTENT_TERMS: Readonly<Record<Exclude<IllegalDetection["intent"], "none" | "informational">, string[]>> = {
  offer: ["ofrezco", "oferta", "tengo", "disponible", "vendo", "paso"],
  sale: ["vendo", "venta", "precio", "pago", "compro", "comprar"],
  exchange: ["intercambio", "cambio", "trueque", "trade"],
  request: ["busco", "buscando", "solicito", "necesito", "alguien tiene"],
  distribution: ["comparto", "compartir", "envio", "enviar", "publico", "descargar"],
  promotion: ["canal", "grupo", "unete", "entra", "link", "enlace"],
  grooming: ["habla conmigo", "conocer", "escribeme", "quedamos"],
  "private-contact": ["privado", "por dm", "mensaje privado", "escribeme", "inbox"],
};

const INFORMATIONAL_TERMS = [
  "denuncio",
  "denuncia",
  "reporto",
  "reporte",
  "noticia",
  "periodistico",
  "educativo",
  "prevencion",
  "condeno",
  "alerta de seguridad",
];
const DIRECT_ACTOR_TERMS = [
  "yo vendo",
  "vendo",
  "ofrezco",
  "busco",
  "compro",
  "cambio por",
  "te envio",
  "te paso",
];
const CODED_REFERENCE_TERMS = ["sepe", "cp3"];
const GROOMING_APPROACH_TERMS = [
  "hablame",
  "escribeme",
  "contactame",
  "conocer",
  "quedamos",
  "mandame mensaje",
];
const INVISIBLE_OR_FORMAT_CHARACTERS = /[\p{Cf}\u034F\uFE00-\uFE0F]/gu;

export interface IllegalDetectionContext {
  hasLink?: boolean;
  forwarded?: boolean;
  repeatedCount?: number;
}

export const DEFAULT_ILLEGAL_RISK_THRESHOLDS: Readonly<IllegalRiskThresholds> = {
  highContextSignals: 2,
  mediumContextSignals: 1,
};

function hasTerm(text: string, term: string): boolean {
  const normalized = normalizeIllegalText(text);
  return findTermPositions(normalized, term).length > 0 ||
    hasNearMissTerm(normalized, normalizeIllegalText(term));
}

function normalizeIllegalText(value: string): string {
  return normalizeFilterTerm(value.normalize("NFKD"))
    .replace(/\p{M}/gu, "")
    .replace(INVISIBLE_OR_FORMAT_CHARACTERS, "")
    .replace(/[\s\S]/gu, (character) => HOMOGLYPHS[character] ?? character)
    .replace(/[01345789@!$|]/g, (character) => ({
      "0": "o",
      "1": "i",
      "3": "e",
      "4": "a",
      "5": "s",
      "7": "t",
      "8": "b",
      "9": "g",
      "@": "a",
      "!": "i",
      "$": "s",
      "|": "i",
    }[character] ?? character))
    .replace(/(.)\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1 || Math.min(left.length, right.length) < 5) {
    return false;
  }
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

function termLetters(value: string): string {
  const letters = normalizeIllegalText(value).match(/[\p{L}\p{N}]/gu) ?? [];
  return letters.filter((letter, index) => index === 0 || letter !== letters[index - 1]).join("");
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function findTermPositions(text: string, term: string): number[] {
  const needle = termLetters(term);
  if (!needle) return [];
  const entries = [...text.matchAll(/[\p{L}\p{N}]/gu)]
    .map((match) => ({ character: match[0] ?? "", index: match.index ?? 0 }))
    .filter((entry, index, all) =>
      index === 0 || entry.character !== all[index - 1]?.character,
    );
  const compact = entries.map((entry) => entry.character).join("");
  const positions: number[] = [];
  let offset = 0;
  while (offset <= compact.length - needle.length) {
    const found = compact.indexOf(needle, offset);
    if (found < 0) break;
    const first = entries[found]?.index ?? 0;
    const lastEntry = entries[found + needle.length - 1];
    const end = lastEntry ? lastEntry.index + lastEntry.character.length : first;
    const before = Array.from(text.slice(0, first)).at(-1);
    const after = Array.from(text.slice(end))[0];
    if (!isWordCharacter(before) && !isWordCharacter(after)) positions.push(first);
    offset = found + 1;
  }
  if (positions.length > 0) return positions;

  const termWords = normalizeIllegalText(term).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (termWords.length === 0 || termWords.some((word) => word.length < 5)) return [];
  const textWords = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  const fuzzyPositions: number[] = [];
  for (let start = 0; start + termWords.length <= textWords.length; start += 1) {
    if (termWords.every((word, index) =>
      editDistanceAtMostOne(word, textWords[start + index]?.[0] ?? ""),
    )) {
      fuzzyPositions.push(textWords[start]?.index ?? 0);
    }
  }
  return fuzzyPositions;
}

function hasNearMissTerm(normalizedText: string, normalizedTerm: string): boolean {
  const termWords = normalizedTerm.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (termWords.length === 0 || termWords.some((word) => word.length < 5)) {
    return false;
  }
  const textWords = normalizedText.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let start = 0; start + termWords.length <= textWords.length; start += 1) {
    if (
      termWords.every((word, index) =>
        editDistanceAtMostOne(word, textWords[start + index] ?? ""),
      )
    ) {
      return true;
    }
  }
  return false;
}

function termsAppearNear(text: string, leftTerms: string[], rightTerms: string[]): boolean {
  const segments = text.split(/(?:\r?\n+|[.!?;]\s+(?=[A-ZÁÉÍÓÚÜÑ¿¡]))/u);
  return segments.some((segment) => {
    const normalized = normalizeIllegalText(segment);
    const leftPositions = leftTerms.flatMap((term) =>
      findTermPositions(normalized, term),
    );
    const rightPositions = rightTerms.flatMap((term) =>
      findTermPositions(normalized, term),
    );
    return leftPositions.some((left) =>
      rightPositions.some((right) => Math.abs(left - right) <= 80),
    );
  });
}

function explicitActorIntent(text: string, customTerms: string[] = []): boolean {
  const markerTerms = [
    ...EXPLICIT_CRITICAL_PHRASES.map((entry) => entry.phrase),
    ...Object.values(CATEGORY_TERMS).flat(),
    ...AMBIGUOUS_TERMS.map((entry) => entry.term),
    ...CODED_REFERENCE_TERMS,
    ...customTerms,
  ];
  return termsAppearNear(text, DIRECT_ACTOR_TERMS, markerTerms);
}

function resolveIntent(
  text: string,
  hasLink: boolean,
  customTerms: string[],
): Exclude<IllegalDetection["intent"], "none"> | "none" {
  if (
    INFORMATIONAL_TERMS.some((term) => hasTerm(text, term)) &&
    !explicitActorIntent(text, customTerms)
  ) {
    return "informational";
  }
  const ageReferenced = AGE_TERMS.some((term) => hasTerm(text, term));
  const privateContact = INTENT_TERMS["private-contact"].some((term) =>
    hasTerm(text, term),
  );
  const directApproach = GROOMING_APPROACH_TERMS.some((term) => hasTerm(text, term));
  if (ageReferenced && privateContact && directApproach) return "grooming";
  const intentPriority: Array<Exclude<IllegalDetection["intent"], "none" | "informational">> = [
    "exchange",
    "sale",
    "request",
    "distribution",
    "offer",
    "grooming",
    "promotion",
    "private-contact",
  ];
  for (const intent of intentPriority) {
    if (INTENT_TERMS[intent].some((term) => hasTerm(text, term))) {
      return intent;
    }
  }
  return hasLink ? "promotion" : "none";
}

function result(
  input: {
    category?: IllegalCategory;
    intent: IllegalDetection["intent"];
    signals: string[];
    risk: IllegalDetection["risk"];
    reason: string;
    normalizationApplied: boolean;
    explicitIntent: boolean;
    critical?: boolean;
  },
): IllegalDetection {
  return {
    category: input.category,
    intent: input.intent,
    risk: input.risk,
    confidence: input.risk === "high"
      ? "high"
      : input.risk === "medium"
        ? "suspicious"
        : "weak",
    normalizationApplied: input.normalizationApplied,
    explicitIntent: input.explicitIntent,
    signals: [...new Set(input.signals)],
    critical: input.critical ?? input.risk === "high",
    needsReview: input.risk === "medium",
    reason: input.reason,
  };
}

function hasCriticalPhrase(text: string, phrase: string): boolean {
  return hasTerm(text, phrase);
}

/**
 * Detecta solicitudes o intercambio de contenido sexual ilegal, con
 * especial atención al abuso sexual infantil. Evalúa el contexto para no
 * sancionar siglas ambiguas ("cp", "zoo") ni palabras cotidianas
 * ("infantil", "menor", "violación") sin contexto suficiente.
 *
 * Nunca requiere descargar, copiar ni almacenar el material referido: solo
 * analiza el texto del mensaje y devuelve una decisión.
 */
export function detectIllegalContent(
  text: string,
  customTerms: string[],
  context: IllegalDetectionContext = {},
  thresholds: IllegalRiskThresholds = DEFAULT_ILLEGAL_RISK_THRESHOLDS,
): IllegalDetection {
  if (
    !Number.isSafeInteger(thresholds.highContextSignals) ||
    thresholds.highContextSignals < 1 ||
    !Number.isSafeInteger(thresholds.mediumContextSignals) ||
    thresholds.mediumContextSignals < 1
  ) {
    throw new Error("ILLEGAL_RISK_THRESHOLDS_INVALID");
  }
  const normalized = normalizeIllegalText(text);
  const normalizationApplied = normalized !== text;
  const hasLink = context.hasLink ?? /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/iu.test(text);
  const repeatedCount = Number.isSafeInteger(context.repeatedCount)
    ? Math.max(0, context.repeatedCount ?? 0)
    : 0;
  const explicit = EXPLICIT_CRITICAL_PHRASES.find((entry) =>
    hasCriticalPhrase(text, entry.phrase),
  );
  const category = (Object.keys(CATEGORY_TERMS) as IllegalCategory[]).find(
    (key) => CATEGORY_TERMS[key].some((term) => hasTerm(text, term)),
  );
  const categoryTerm = category
    ? CATEGORY_TERMS[category].find((term) => hasTerm(text, term))
    : undefined;
  const customMatch = customTerms.find((term) => hasTerm(text, term));
  const ambiguous = AMBIGUOUS_TERMS.find((entry) => hasTerm(text, entry.term));

  const hasAge = AGE_TERMS.some((term) => hasTerm(text, term));
  const hasAction = ACTION_TERMS.some((term) => hasTerm(text, term));
  const hasSexualContext = SEXUAL_CONTEXT_TERMS.some((term) =>
    hasTerm(text, term),
  );
  const codeReference = CODED_REFERENCE_TERMS.find((term) => hasTerm(text, term));
  const intent = resolveIntent(text, hasLink, customTerms);
  const directIntent = explicitActorIntent(text, customTerms);
  const privateContact = INTENT_TERMS["private-contact"].some((term) =>
    hasTerm(text, term),
  );
  const linkSignal = hasLink || context.forwarded === true;
  const ageSignal = hasAge || Boolean(ambiguous || codeReference);
  const relevantCategory =
    explicit?.category ??
    category ??
    ambiguous?.category ??
    (codeReference || customMatch ? "other-illegal-sexual" : undefined);
  const contextualSignals = [
    ...(ageSignal ? ["age-or-coded-reference"] : []),
    ...(hasSexualContext || Boolean(explicit) ? ["sexual-content-context"] : []),
    ...(intent !== "none" && intent !== "informational" ? [`intent:${intent}`] : []),
    ...(linkSignal ? ["link-or-forward-context"] : []),
    ...(privateContact ? ["private-contact-context"] : []),
  ];
  const informative = intent === "informational";

  if (informative) {
    return result({
      category: relevantCategory,
      intent,
      signals: [...contextualSignals, "informational-or-reporting-context"],
      risk: "low",
      reason: "Mención informativa o de denuncia sin intención operativa del autor.",
      normalizationApplied,
      explicitIntent: false,
    });
  }

  const transactionIntent = ["offer", "sale", "exchange", "request", "distribution", "promotion"]
    .includes(intent);
  const groomingIntent = intent === "grooming";
  const highSignalCount = Number(ageSignal) +
    Number(hasSexualContext || Boolean(explicit)) +
    Number(transactionIntent || groomingIntent) +
    Number(linkSignal || privateContact);
  const hasAbuseMarker = Boolean(
    explicit || category || ambiguous || codeReference || customMatch || groomingIntent,
  );
  const markerTerms = [
    ...(explicit ? [explicit.phrase] : []),
    ...(categoryTerm ? [categoryTerm] : []),
    ...(ambiguous ? [ambiguous.term] : []),
    ...(codeReference ? [codeReference] : []),
    ...(customMatch ? [customMatch] : []),
  ];
  const intentTerms = transactionIntent ? INTENT_TERMS[intent as keyof typeof INTENT_TERMS] ?? [] : [];
  const relatedIntent = groomingIntent
    ? hasAge && privateContact
    : termsAppearNear(text, markerTerms, intentTerms);

  if (
    hasAbuseMarker &&
    (explicit || category || customMatch || ambiguous || codeReference) &&
    (transactionIntent || groomingIntent) &&
    highSignalCount >= thresholds.highContextSignals &&
    relatedIntent
  ) {
    return result({
      category: relevantCategory,
      intent: groomingIntent ? "grooming" : intent,
      signals: [
        ...contextualSignals,
        ...(explicit ? ["explicit-abuse-reference"] : []),
        ...(ambiguous ? ["ambiguous-term"] : []),
        ...(codeReference ? ["coded-reference"] : []),
        ...(customMatch ? ["custom-term"] : []),
      ],
      risk: "high",
      reason: "Referencia relevante con intención operativa y señales contextuales corroborantes.",
      normalizationApplied,
      explicitIntent:
        directIntent || groomingIntent || (transactionIntent && relatedIntent),
      critical: true,
    });
  }

  const mediumSignalCount = Number(hasAbuseMarker) +
    Number(transactionIntent || groomingIntent) +
    Number(linkSignal || privateContact) +
    Number(repeatedCount >= 2);
  if (
    hasAbuseMarker &&
    (mediumSignalCount >= thresholds.mediumContextSignals) &&
    (relatedIntent || linkSignal || repeatedCount >= 2)
  ) {
    return result({
      category: relevantCategory,
      intent,
      signals: [
        ...contextualSignals,
        ...(ambiguous ? ["ambiguous-term"] : []),
        ...(codeReference ? ["coded-reference"] : []),
        ...(customMatch ? ["custom-term"] : []),
        ...(repeatedCount >= 2 ? ["repeated-user-behavior"] : []),
      ],
      risk: "medium",
      reason: "Varias señales compatibles requieren revisión humana.",
      normalizationApplied,
      explicitIntent:
        directIntent || groomingIntent || (transactionIntent && relatedIntent),
    });
  }

  if (hasAbuseMarker) {
    return result({
      category: relevantCategory,
      intent: "none",
      signals: [
        ...contextualSignals,
        ...(ambiguous ? ["ambiguous-term"] : []),
        ...(codeReference ? ["coded-reference"] : []),
        ...(customMatch ? ["custom-term"] : []),
        ...(explicit ? ["explicit-abuse-reference"] : []),
      ],
      risk: "low",
      reason: "Coincidencia aislada sin evidencia suficiente de intención operativa.",
      normalizationApplied,
      explicitIntent: false,
    });
  }

  return result({
    intent: "none",
    signals: [
      ...(hasAge ? ["age-context"] : []),
      ...(hasAction ? ["exchange-context"] : []),
      ...(hasSexualContext ? ["sexual-context"] : []),
      ...(context.forwarded ? ["forwarded-message"] : []),
      ...(repeatedCount >= 2 ? ["repeated-user-behavior"] : []),
    ],
    risk: "low",
    reason: "Sin señales de contenido sexual ilegal.",
    normalizationApplied,
    explicitIntent: false,
  });
}
