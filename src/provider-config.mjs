const DEEPSEEK_SECTION = "model_providers.deepseek";

function sectionRange(lines, sectionName) {
  const header = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*(?:#.*)?$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

export function inspectDeepSeekProvider(text) {
  const lines = text.split(/\r?\n/);
  const range = sectionRange(lines, DEEPSEEK_SECTION);
  if (!range) return { found: false, baseUrl: null };

  for (let index = range.start + 1; index < range.end; index += 1) {
    const match = lines[index].match(
      /^(\s*)base_url\s*=\s*"([^"]*)"\s*(?:#.*)?$/,
    );
    if (match) return { found: true, baseUrl: match[2] };
  }
  return { found: true, baseUrl: null };
}

export function setDeepSeekBaseUrl(text, baseUrl) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const range = sectionRange(lines, DEEPSEEK_SECTION);
  if (!range) {
    const error = new Error(
      "Codex config does not contain [model_providers.deepseek]. Configure the direct DeepSeek provider first.",
    );
    error.code = "DEEPSEEK_PROVIDER_NOT_FOUND";
    throw error;
  }

  let baseUrlIndex = -1;
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^\s*base_url\s*=/.test(lines[index])) {
      baseUrlIndex = index;
      break;
    }
  }

  if (baseUrlIndex >= 0) {
    const indent = lines[baseUrlIndex].match(/^\s*/)?.[0] ?? "";
    lines[baseUrlIndex] = `${indent}base_url = "${baseUrl}"`;
  } else {
    lines.splice(range.start + 1, 0, `base_url = "${baseUrl}"`);
  }

  return lines.join(eol);
}
