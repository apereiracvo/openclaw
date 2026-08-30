const ERROR_EMOJI_RE =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Extended_Pictographic}|\p{Emoji_Modifier})*)+/gu;

// Error surfaces already carry a dedicated alert icon. Keep producer text intact
// and remove decorative glyphs only where the WebUI presents that text.
export function formatWebUiErrorText(error: string): string {
  return error.replace(ERROR_EMOJI_RE, " ").replace(/[ \t]{2,}/gu, " ").trim();
}
