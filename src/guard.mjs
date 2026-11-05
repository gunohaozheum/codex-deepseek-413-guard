const MEBIBYTE = 1024 * 1024;

export const HISTORY_IMAGE_PLACEHOLDER =
  "[Historical image omitted by Codex DeepSeek 413 Guard. The current user turn and its images are preserved.]";

function inlineImagePayloadChars(part) {
  if (!part || typeof part !== "object" || part.type !== "input_image") {
    return 0;
  }
  return [part.image_url, part.url].reduce((total, value) => {
    return typeof value === "string" && value.startsWith("data:image/")
      ? total + value.length
      : total;
  }, 0);
}

function stripInlineImages(value, stats) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const stripped = stripInlineImages(entry, stats);
      changed ||= stripped !== entry;
      return stripped;
    });
    return changed ? next : value;
  }

  if (!value || typeof value !== "object") return value;

  const payloadChars = inlineImagePayloadChars(value);
  if (payloadChars > 0) {
    stats.prunedImages += 1;
    stats.prunedPayloadChars += payloadChars;
    return {
      type: "input_text",
      text: HISTORY_IMAGE_PLACEHOLDER,
    };
  }

  let changed = false;
  const next = { ...value };
  for (const [key, entry] of Object.entries(value)) {
    const stripped = stripInlineImages(entry, stats);
    if (stripped !== entry) {
      next[key] = stripped;
      changed = true;
    }
  }
  return changed ? next : value;
}

export function pruneHistoricalInlineImages(
  body,
  { enabled = true, pruneAtBytes = 44 * MEBIBYTE } = {},
) {
  const beforeBytes = Buffer.byteLength(JSON.stringify(body));
  const unchanged = {
    body,
    changed: false,
    enabled,
    beforeBytes,
    afterBytes: beforeBytes,
    prunedImages: 0,
    prunedPayloadChars: 0,
  };

  if (!enabled || beforeBytes <= pruneAtBytes || !Array.isArray(body?.input)) {
    return unchanged;
  }

  let lastUserMessageIndex = -1;
  for (let index = 0; index < body.input.length; index += 1) {
    const item = body.input[index];
    if (item?.role === "user" && (!item.type || item.type === "message")) {
      lastUserMessageIndex = index;
    }
  }
  if (lastUserMessageIndex < 0) return unchanged;

  const stats = {
    prunedImages: 0,
    prunedPayloadChars: 0,
  };
  const input = body.input.map((item, index) => {
    return index < lastUserMessageIndex
      ? stripInlineImages(item, stats)
      : item;
  });
  if (stats.prunedImages === 0) return unchanged;

  const prunedBody = { ...body, input };
  return {
    body: prunedBody,
    changed: true,
    enabled,
    beforeBytes,
    afterBytes: Buffer.byteLength(JSON.stringify(prunedBody)),
    ...stats,
  };
}
