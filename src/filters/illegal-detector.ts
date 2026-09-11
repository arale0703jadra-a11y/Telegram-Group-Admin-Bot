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
}

const CATEGORY_TERMS: Record<IllegalCategory, string[]> = {
  "minor-exploitation": [
    "explotacion de menores",
    "explotación infantil",
    "menor sexual",
    "abuso de menores",
    "menor",
    "menores",
    "infantil",
    "nino",
    "nina",
    "adolescente",
  ],
  "child-abuse": [
    "abuso sexual infantil",
    "abuso infantil",
    "material de abuso infantil",
    "material infantil ilegal",
    "abuso",
  ],
  grooming: [
    "grooming",
    "captacion de menores",
    "captación sexual de menores",
    "contacto sexual con menores",
  ],
  bestiality: ["zoo", "zoofilia", "bestialidad", "sexo con animales"],
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
    "cp",
    "violacion",
    "abuso sexual",
    "explotacion sexual",
  ],
};

const AGE_TERMS = ["menor", "menores", "infantil", "adolescente"];
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

function hasTerm(text: string, term: string): boolean {
  const normalized = normalizeIllegalText(text);
  const normalizedTerm = normalizeIllegalText(term);
  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(normalized) || (
    normalizedTerm.replace(/\s/g, "").length >= 5 &&
    normalized.replace(/[^\p{L}\p{N}]/gu, "").includes(normalizedTerm.replace(/\s/g, ""))
  );
}

function normalizeIllegalText(value: string): string {
  return normalizeFilterTerm(value)
    .replace(/[013457@]/g, (character) => ({
      "0": "o",
      "1": "i",
      "3": "e",
      "4": "a",
      "5": "s",
      "7": "t",
      "@": "a",
    })[character] ?? character)
    .replace(/([^\p{L}\p{N}])\1+/gu, "$1")
    .replace(/(.)\1{2,}/gu, "$1$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectIllegalContent(
  text: string,
  customTerms: string[],
): IllegalDetection {
  const category = (Object.keys(CATEGORY_TERMS) as IllegalCategory[]).find((key) =>
    CATEGORY_TERMS[key].some((term) => hasTerm(text, term)),
  );
  const customMatch = customTerms.find((term) => hasTerm(text, term));
  const hasAge = AGE_TERMS.some((term) => hasTerm(text, term));
  const hasAction = ACTION_TERMS.some((term) => hasTerm(text, term));
  const hasSexualContext = SEXUAL_CONTEXT_TERMS.some((term) => hasTerm(text, term));
  const signals = [
    ...(category ? [category] : []),
    ...(customMatch ? ["custom"] : []),
    ...(hasAge ? ["age-context"] : []),
    ...(hasAction ? ["exchange-context"] : []),
    ...(hasSexualContext ? ["sexual-context"] : []),
  ];

  if (!category && !customMatch) {
    return { confidence: "weak", signals };
  }
  const categoryTerm = category
    ? CATEGORY_TERMS[category].find((term) => hasTerm(text, term))
    : undefined;
  const categoryAlreadyContainsAge = categoryTerm
    ? AGE_TERMS.some((term) => normalizeIllegalText(categoryTerm).includes(normalizeIllegalText(term)))
    : false;
  const independentAge = hasAge && !categoryAlreadyContainsAge;
  const categoryIsExplicit = categoryTerm
    ? [...SEXUAL_CONTEXT_TERMS, ...INHERENTLY_EXPLICIT_CATEGORY_TERMS].some((term) =>
        normalizeIllegalText(categoryTerm).includes(normalizeIllegalText(term)),
      )
    : false;
  const independentSexualContext = hasSexualContext && !categoryIsExplicit;

  if (
    (category &&
      hasAction &&
      (categoryIsExplicit || independentSexualContext)) ||
    (customMatch && independentSexualContext && independentAge && hasAction)
  ) {
    return { category, confidence: "high", signals };
  }
  return { category, confidence: "suspicious", signals };
}
