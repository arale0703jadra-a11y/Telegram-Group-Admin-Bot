const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;
const INVISIBLE_FORMAT_CHARACTERS =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu;
const HTML_TAGS = /<\/?[a-z][^>]*>/giu;
const MARKDOWN_MARKERS = /(?:```|`{1,2}|\*{1,2}|~{2}|\|{2})/gu;

/**
 * Normalizes untrusted Telegram text for matching only. It never executes
 * markup or scripts and leaves visible payload text available to filters.
 */
export function sanitizeIncomingText(value: string, maxLength = 4096): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new Error("SANITIZER_MAX_LENGTH_INVALID");
  }
  const bounded = value.slice(0, maxLength);
  return bounded
    .replace(CONTROL_CHARACTERS, "")
    .replace(INVISIBLE_FORMAT_CHARACTERS, "")
    .replace(/<script\b[^>]*>|<\/script\s*>/giu, "")
    .replace(HTML_TAGS, "")
    .replace(MARKDOWN_MARKERS, "");
}
