const ERROR_EMOJI_RE =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Extended_Pictographic}|\p{Emoji_Modifier})*)+/gu;
const ERROR_WARNING_PREFIX_RE = /^\s*(?:⚠️|⛔|❌)/u;

// Error surfaces already carry a dedicated alert icon. Keep producer text intact
// and remove decorative glyphs only where the WebUI presents that text.
export function formatWebUiErrorText(error: string): string {
  return error.replace(ERROR_EMOJI_RE, "");
}

/** Keep ordinary assistant emoji; only explicit warning/error replies use alert presentation. */
export function formatWebUiTranscriptWarningText(text: string): string {
  return ERROR_WARNING_PREFIX_RE.test(text) ? formatWebUiErrorText(text) : text;
}
