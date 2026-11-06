import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_IMAGE_PLACEHOLDER,
  pruneHistoricalInlineImages,
} from "./guard.mjs";

test("prunes historical inline images and preserves the current turn", () => {
  const oldImage = `data:image/png;base64,${"A".repeat(2048)}`;
  const currentImage = `data:image/png;base64,${"B".repeat(2048)}`;
  const body = {
    model: "deepseek-flash",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "old" },
          { type: "input_image", image_url: oldImage },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call_old",
        output: [{ type: "input_image", image_url: oldImage }],
      },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "current" },
          { type: "input_image", image_url: currentImage },
        ],
      },
    ],
  };

  const result = pruneHistoricalInlineImages(body, {
    pruneAtBytes: 1024,
  });

  assert.equal(result.changed, true);
  assert.equal(result.prunedImages, 2);
  assert.deepEqual(result.body.input[0].content[1], {
    type: "input_text",
    text: HISTORY_IMAGE_PLACEHOLDER,
  });
  assert.deepEqual(result.body.input[1].output[0], {
    type: "input_text",
    text: HISTORY_IMAGE_PLACEHOLDER,
  });
  assert.equal(result.body.input[2].content[1].image_url, currentImage);
  assert.equal(body.input[0].content[1].image_url, oldImage);
});

test("prunes historical remote images even for small requests", () => {
  const body = {
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.com/image.png",
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "current" }],
      },
    ],
  };

  const small = pruneHistoricalInlineImages(body, {
    pruneAtBytes: 1024 * 1024,
  });
  assert.equal(small.changed, true);
  assert.deepEqual(small.body.input[0].content[0], {
    type: "input_text",
    text: HISTORY_IMAGE_PLACEHOLDER,
  });
});

test("limits current-turn images to the configured count", () => {
  const images = [1, 2, 3].map((number) => ({
    type: "input_image",
    image_url: `data:image/png;base64,${String(number).repeat(128)}`,
  }));
  const body = {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "current" }, ...images],
      },
    ],
  };

  const result = pruneHistoricalInlineImages(body, {
    pruneAtBytes: 1024 * 1024,
    hardLimitBytes: 2 * 1024 * 1024,
    maxCurrentImages: 2,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.body.input[0].content[1], {
    type: "input_text",
    text: HISTORY_IMAGE_PLACEHOLDER,
  });
  assert.equal(result.body.input[0].content[2], images[1]);
  assert.equal(result.body.input[0].content[3], images[2]);
});

test("the disable switch bypasses pruning", () => {
  const body = {
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${"A".repeat(1024)}`,
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "current" }],
      },
    ],
  };
  const result = pruneHistoricalInlineImages(body, {
    enabled: false,
    pruneAtBytes: 1,
  });
  assert.equal(result.changed, false);
  assert.equal(result.body, body);
});
