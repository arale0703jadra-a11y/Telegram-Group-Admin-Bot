import type { IllegalConfidence } from "../storage/types.js";
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
  signals: string[];
  critical: boolean;
  /** La detección es ambigua: conviene revisión humana antes de sancionar. */
  needsReview: boolean;
  reason: string;
}

/**
 * Frases EXPLÍCITAS e inequívocas de abuso o contenido sexual ilegal.
 * Su presencia, por sí sola, justifica la máxima gravedad: no admiten una
 * lectura cotidiana.
 */
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
const INHERENTLY_EXPLICIT_CATEGORY_TERMS = [
  "zoofilia",
  "bestialidad",
  "grooming",
  "sexo con animales",
  "abuso sexual",
  "explotacion sexual",
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

function hasTerm(text: string, term: string): boolean {
  const normalized = normalizeIllegalText(text);
  const characters = [...normalizeIllegalText(term)].filter((character) =>
    /[\p{L}\p{N}]/u.test(character),
  );
  if (characters.length === 0) {
    return false;
  }

  const separator = "[\\p{P}\\p{Z}\\p{S}\\s_]*";
  const pattern = characters
    .map((character) => {
      const escaped = character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return `${escaped}+`;
    })
    .join(separator);
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(normalized);
}

function normalizeIllegalText(value: string): string {
  return normalizeFilterTerm(value.normalize("NFKD"))
    .replace(/\p{M}/gu, "")
    .replace(/[\s\S]/gu, (character) => HOMOGLYPHS[character] ?? character)
    .replace(/[013457@]/g, (character) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a" }[character] ?? character))
    .replace(/(.)\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
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
): IllegalDetection {
  // 1) Frases explícitas e inequívocas: gravedad máxima directa.
  const explicit = EXPLICIT_CRITICAL_PHRASES.find((entry) =>
    hasCriticalPhrase(text, entry.phrase),
  );
  if (explicit) {
    return {
      category: explicit.category,
      confidence: "high",
      signals: [explicit.phrase, "explicit-critical"],
      critical: true,
      needsReview: false,
      reason: "Frase explícita de contenido sexual ilegal.",
    };
  }

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

  const categoryIsExplicit = categoryTerm
    ? [...SEXUAL_CONTEXT_TERMS, ...INHERENTLY_EXPLICIT_CATEGORY_TERMS].some(
        (term) =>
          normalizeIllegalText(categoryTerm).includes(
            normalizeIllegalText(term),
          ),
      )
    : false;
  const independentSexualContext = hasSexualContext && !categoryIsExplicit;

  // Contexto suficiente para elevar un término ambiguo o débil a alto.
  const strongContext = hasAge && (hasSexualContext || hasAction);

  const signals = [
    ...(category ? [category] : []),
    ...(customMatch ? ["custom"] : []),
    ...(ambiguous ? [`ambiguous:${ambiguous.term}`] : []),
    ...(hasAge ? ["age-context"] : []),
    ...(hasAction ? ["exchange-context"] : []),
    ...(hasSexualContext ? ["sexual-context"] : []),
  ];

  // 2) Término ambiguo SOLO cuenta como alto con contexto claro.
  if (ambiguous && strongContext) {
    return {
      category: ambiguous.category,
      confidence: "high",
      signals,
      critical: false,
      needsReview: false,
      reason: `Término ambiguo "${ambiguous.term}" acompañado de contexto de edad y sexual/de intercambio.`,
    };
  }

  // 3) Categoría o término personalizado con la combinación clásica
  //    (acción + contexto sexual) -> alto.
  if (
    (category && hasAction && (categoryIsExplicit || independentSexualContext)) ||
    (customMatch && strongContext && hasAction)
  ) {
    return {
      category,
      confidence: "high",
      signals,
      critical: false,
      needsReview: false,
      reason: "Solicitud o intercambio con contexto sexual y de edad claros.",
    };
  }

  // 4) Coincidencia parcial (palabra de contexto, término ambiguo suelto o
  //    personalizado sin contexto pleno): ambigua, para revisión humana.
  if (category || customMatch) {
    return {
      category,
      confidence: "suspicious",
      signals,
      critical: false,
      needsReview: true,
      reason:
        "Coincidencia parcial sin contexto suficiente; se sugiere revisión antes de sancionar.",
    };
  }

  // 5) Sin señal relevante (incluye siglas ambiguas aisladas).
  return {
    confidence: "weak",
    signals,
    critical: false,
    needsReview: false,
    reason: "Sin señales de contenido sexual ilegal.",
  };
}
