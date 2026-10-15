export function buttonCallbackData(button: unknown): string | undefined {
  if (typeof button !== "object" || button === null || !("callback_data" in button)) {
    return undefined;
  }
  return typeof button.callback_data === "string"
    ? button.callback_data
    : undefined;
}
