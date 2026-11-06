const MEBIBYTE = 1024 * 1024;

export const HISTORY_IMAGE_PLACEHOLDER =
  "[Image omitted by Codex DeepSeek 413 Guard to reduce repeated image-token cost or satisfy the request-size limit.]";

function imagePartSize(part) {
  if (!part || typeof part !== "object" || part.type !== "input_image") return 0;
  return [part.image_url, part.url].reduce((total, value) => {
    return typeof value === "string" ? total + value.length : total;
  }, typeof part.file_id === "string" ? part.file_id.length : 1);
}

function collectImageParts(value, output) {
  if (Array.isArray(value)) {
    for (const entry of value) collectImageParts(entry, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (value.type === "input_image") {
    output.push(value);
    return output;
  }
  for (const entry of Object.values(value)) collectImageParts(entry, output);
  return output;
}

function replaceImageParts(value, targets, stats) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const replaced = replaceImageParts(entry, targets, stats);
      changed ||= replaced !== entry;
      return replaced;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") return value;
  if (value.type === "input_image" && targets.has(value)) {
    stats.prunedImages += 1;
    stats.prunedPayloadChars += imagePartSize(value);
    return { type: "input_text", text: HISTORY_IMAGE_PLACEHOLDER };
  }
  let changed = false;
  const next = { ...value };
  for (const [key, entry] of Object.entries(value)) {
    const replaced = replaceImageParts(entry, targets, stats);
    if (replaced !== entry) {
      next[key] = replaced;
      changed = true;
    }
  }
  return changed ? next : value;
}

export function pruneHistoricalInlineImages(
  body,
  {
    enabled = true,
    pruneAtBytes = 44 * MEBIBYTE,
    hardLimitBytes = 47 * MEBIBYTE,
    maxCurrentImages = 2,
  } = {},
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

  if (!enabled || !Array.isArray(body?.input)) {
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
  const historicalImages = new Set();
  for (let index = 0; index < lastUserMessageIndex; index += 1) {
    for (const image of collectImageParts(body.input[index], [])) {
      historicalImages.add(image);
    }
  }

  let input = body.input.map((item, index) => {
    return index < lastUserMessageIndex
      ? replaceImageParts(item, historicalImages, stats)
      : item;
  });
  let prunedBody = { ...body, input };
  let currentBytes = Buffer.byteLength(JSON.stringify(prunedBody));

  const currentImages = [];
  for (let index = lastUserMessageIndex; index < input.length; index += 1) {
    currentImages.push(...collectImageParts(input[index], []));
  }
  const allowedCurrentImages =
    currentBytes > pruneAtBytes ? 1 : Math.max(0, maxCurrentImages);
  const excessCurrentImages = new Set(
    currentImages.slice(0, Math.max(0, currentImages.length - allowedCurrentImages)),
  );
  if (excessCurrentImages.size > 0) {
    input = input.map((item, index) => {
      return index < lastUserMessageIndex
        ? item
        : replaceImageParts(item, excessCurrentImages, stats);
    });
    prunedBody = { ...body, input };
    currentBytes = Buffer.byteLength(JSON.stringify(prunedBody));
  }

  if (currentBytes > hardLimitBytes) {
    const remainingCurrentImages = new Set();
    for (let index = lastUserMessageIndex; index < input.length; index += 1) {
      for (const image of collectImageParts(input[index], [])) {
        remainingCurrentImages.add(image);
      }
    }
    if (remainingCurrentImages.size > 0) {
      input = input.map((item, index) => {
        return index < lastUserMessageIndex
          ? item
          : replaceImageParts(item, remainingCurrentImages, stats);
      });
      prunedBody = { ...body, input };
    }
  }

  if (stats.prunedImages === 0) return unchanged;
  return {
    body: prunedBody,
    changed: true,
    enabled,
    beforeBytes,
    afterBytes: Buffer.byteLength(JSON.stringify(prunedBody)),
    ...stats,
  };
}
