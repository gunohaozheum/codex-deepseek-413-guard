import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectDeepSeekProvider,
  setDeepSeekBaseUrl,
} from "./provider-config.mjs";

const SAMPLE = [
  'model_provider = "deepseek"',
  "",
  "[model_providers.deepseek]",
  'name = "DeepSeek"',
  'base_url = "https://api.deepseek.com/"',
  'wire_api = "responses"',
  'experimental_bearer_token = "placeholder"',
  "",
  "[model_providers.other]",
  'base_url = "https://example.com/"',
].join("\n");

test("inspects the DeepSeek provider without reading credentials", () => {
  assert.deepEqual(inspectDeepSeekProvider(SAMPLE), {
    found: true,
    baseUrl: "https://api.deepseek.com/",
  });
});

test("changes only the DeepSeek base URL", () => {
  const local = setDeepSeekBaseUrl(
    SAMPLE,
    "http://127.0.0.1:18766/v1",
  );
  assert.match(local, /base_url = "http:\/\/127\.0\.0\.1:18766\/v1"/);
  assert.match(local, /experimental_bearer_token = "placeholder"/);
  assert.match(local, /\[model_providers\.other\]/);
});

test("restores the official base URL", () => {
  const local = setDeepSeekBaseUrl(
    SAMPLE,
    "http://127.0.0.1:18766/v1",
  );
  const direct = setDeepSeekBaseUrl(local, "https://api.deepseek.com/");
  assert.deepEqual(inspectDeepSeekProvider(direct), {
    found: true,
    baseUrl: "https://api.deepseek.com/",
  });
});

test("reports a missing provider", () => {
  assert.deepEqual(inspectDeepSeekProvider("[model_providers.other]\n"), {
    found: false,
    baseUrl: null,
  });
  assert.throws(
    () =>
      setDeepSeekBaseUrl(
        "[model_providers.other]\n",
        "http://127.0.0.1:18766/v1",
      ),
    /does not contain/,
  );
});
