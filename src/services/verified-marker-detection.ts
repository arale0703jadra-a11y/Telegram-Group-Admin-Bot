function normalizeMarkerText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("es")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function normalizeConfiguredVerifiedMarkers(
  input: string,
): string[] | undefined {
  const markers = input
    .split(/[,\n\r]+/u)
    .map((marker) => marker.trim())
    .filter(Boolean);
  if (
    markers.length === 0 ||
    markers.length > 20 ||
    markers.some((marker) => marker.length > 64 || !normalizeMarkerText(marker))
  ) {
    return undefined;
  }
  const normalized = new Set<string>();
  for (const marker of markers) {
    const key = normalizeMarkerText(marker);
    if (normalized.has(key)) return undefined;
    normalized.add(key);
  }
  return markers;
}

export function findConfiguredVerifiedMarker(
  values: readonly string[],
  configuredMarkers: readonly string[],
): string | undefined {
  const normalizedValues = values
    .filter(Boolean)
    .map(normalizeMarkerText)
    .filter(Boolean);
  for (const marker of configuredMarkers) {
    const normalizedMarker = normalizeMarkerText(marker);
    if (!normalizedMarker) continue;
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])${normalizedMarker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "[\\p{P}\\p{S}\\p{Z}\\s]+")}(?=$|[^\\p{L}\\p{N}])`,
      "iu",
    );
    if (normalizedValues.some((value) => pattern.test(value))) return marker;
  }
  return undefined;
}
