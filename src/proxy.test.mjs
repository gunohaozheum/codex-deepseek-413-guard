import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createGuardServer } from "./proxy.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("health endpoint identifies the guard", async () => {
  const expectedMaxRequestBytes = 256 * 1024 * 1024;
  const server = createGuardServer();
  const port = await listen(server);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.service, "codex-deepseek-413-guard");
  assert.equal(body.maxRequestBytes, expectedMaxRequestBytes);
  await close(server);
});

test("oversized current-turn content is rejected before the upstream", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  const server = createGuardServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    pruneAtBytes: 128,
    hardLimitBytes: 256,
    isPaused: () => false,
  });
  const port = await listen(server);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-only",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-flash",
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
      ],
    }),
  });
  assert.equal(response.status, 413);
  assert.equal(upstreamCalls, 0);

  await close(server);
  await close(upstream);
});

test("transport-level request limit returns a normal 413 response", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.end("{}");
  });
  const upstreamPort = await listen(upstream);
  const server = createGuardServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    maxRequestBytes: 128,
    pruneAtBytes: 256,
    hardLimitBytes: 512,
    isPaused: () => false,
  });
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-only",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "A".repeat(1024) }),
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.error.type, "request_too_large");
  assert.equal(upstreamCalls, 0);

  await close(server);
  await close(upstream);
});

test("historical images are pruned before forwarding", async () => {
  let received = "";
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const upstreamPort = await listen(upstream);
  const server = createGuardServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    pruneAtBytes: 128,
    hardLimitBytes: 100_000,
    isPaused: () => false,
  });
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-only",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-flash",
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
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(received.includes("data:image/"), false);
  assert.match(received, /input_text/);

  await close(server);
  await close(upstream);
});

test("pause mode forwards without pruning", async () => {
  let received = "";
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const upstreamPort = await listen(upstream);
  const server = createGuardServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    pruneAtBytes: 1,
    hardLimitBytes: 1,
    isPaused: () => true,
  });
  const port = await listen(server);

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-only",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-flash",
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
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(received.includes("data:image/"), true);

  await close(server);
  await close(upstream);
});
