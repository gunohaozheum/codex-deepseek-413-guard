import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { pruneHistoricalInlineImages } from "./guard.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MEBIBYTE = 1024 * 1024;
const SETTINGS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "guard.config.json"), "utf8"),
);
const HOST = process.env.DEEPSEEK_GUARD_HOST ?? SETTINGS.host;
const PORT = Number(process.env.DEEPSEEK_GUARD_PORT ?? SETTINGS.port);
const UPSTREAM_BASE_URL = (
  process.env.DEEPSEEK_GUARD_UPSTREAM_BASE_URL ??
  SETTINGS.upstreamBaseUrl
).replace(/\/+$/, "");
const MAX_REQUEST_BYTES =
  Number(process.env.DEEPSEEK_GUARD_MAX_REQUEST_BYTES) ||
  Number(SETTINGS.maxRequestMiB) * MEBIBYTE;
const PRUNE_AT_BYTES =
  Number(process.env.DEEPSEEK_GUARD_PRUNE_AT_BYTES) ||
  Number(SETTINGS.pruneAtMiB) * MEBIBYTE;
const HARD_LIMIT_BYTES =
  Number(process.env.DEEPSEEK_GUARD_HARD_LIMIT_BYTES) ||
  Number(SETTINGS.hardLimitMiB) * MEBIBYTE;
const UPSTREAM_TIMEOUT_MS =
  Number(SETTINGS.upstreamTimeoutMinutes) * 60 * 1000;
const PAUSE_FLAG_PATH = path.join(ROOT, "runtime", "paused.flag");
const PID_PATH = path.join(ROOT, "runtime", "proxy.pid");

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req, maxRequestBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxRequestBytes) {
        reject(
          new Error(
            `Request body exceeds the local ${(maxRequestBytes / MEBIBYTE).toFixed(2)} MiB safety limit.`,
          ),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function paused(options) {
  if (typeof options.isPaused === "function") return options.isPaused();
  const envValue = String(process.env.DEEPSEEK_GUARD_PAUSE ?? "").toLowerCase();
  return (
    ["1", "true", "yes", "on"].includes(envValue) ||
    fs.existsSync(options.pauseFlagPath ?? PAUSE_FLAG_PATH)
  );
}

function apiAuthorization(req, options) {
  const incoming = req.headers.authorization;
  if (typeof incoming === "string" && incoming.startsWith("Bearer ")) {
    return incoming;
  }
  const fallback = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (fallback) {
    return `Bearer ${fallback}`;
  }
  return null;
}

export function createGuardServer(options = {}) {
  const settings = {
    host: options.host ?? HOST,
    port: options.port ?? PORT,
    upstreamBaseUrl: (options.upstreamBaseUrl ?? UPSTREAM_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    maxRequestBytes: options.maxRequestBytes ?? MAX_REQUEST_BYTES,
    pruneAtBytes: options.pruneAtBytes ?? PRUNE_AT_BYTES,
    hardLimitBytes: options.hardLimitBytes ?? HARD_LIMIT_BYTES,
    upstreamTimeoutMs:
      options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
    pauseFlagPath: options.pauseFlagPath ?? PAUSE_FLAG_PATH,
    apiKey: options.apiKey,
    isPaused: options.isPaused,
  };

  return http.createServer(async (req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${settings.host}:${settings.port}`,
    );

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        status: "ok",
        service: "codex-deepseek-413-guard",
        pid: process.pid,
        paused: paused(settings),
        pruneAtBytes: settings.pruneAtBytes,
        hardLimitBytes: settings.hardLimitBytes,
      });
      return;
    }

    if (
      req.method !== "POST" ||
      (url.pathname !== "/v1/responses" && url.pathname !== "/responses")
    ) {
      json(res, 404, {
        error: { message: "Not found.", type: "invalid_request_error" },
      });
      return;
    }

    let bodyBuffer;
    try {
      bodyBuffer = await readBody(req, settings.maxRequestBytes);
    } catch (error) {
      json(res, 413, {
        error: { message: error.message, type: "request_too_large" },
      });
      return;
    }

    let body;
    try {
      body = JSON.parse(bodyBuffer.toString("utf8"));
    } catch {
      json(res, 400, {
        error: {
          message: "Request body must be valid JSON.",
          type: "invalid_request_error",
        },
      });
      return;
    }

    const authorization = apiAuthorization(req, settings);
    if (!authorization) {
      json(res, 401, {
        error: {
          message:
            "No DeepSeek bearer token was received. Keep the existing Codex DeepSeek provider token in config.toml.",
          type: "authentication_error",
        },
      });
      return;
    }

    const guard = pruneHistoricalInlineImages(body, {
      enabled: !paused(settings),
      pruneAtBytes: settings.pruneAtBytes,
    });
    body = guard.body;
    const serializedBody = JSON.stringify(body);

    if (guard.changed) {
      console.log(
        `[guard] pruned model=${body.model ?? "unknown"} beforeBytes=${guard.beforeBytes} afterBytes=${guard.afterBytes} images=${guard.prunedImages}`,
      );
    }

    if (guard.enabled && guard.afterBytes > settings.hardLimitBytes) {
      json(res, 413, {
        error: {
          message: `Request is ${(guard.afterBytes / MEBIBYTE).toFixed(2)} MiB after pruning historical images; the local safety limit is ${(settings.hardLimitBytes / MEBIBYTE).toFixed(2)} MiB. Start a new task or reduce current-turn attachments.`,
          type: "request_too_large",
        },
        details: {
          beforeBytes: guard.beforeBytes,
          afterBytes: guard.afterBytes,
          prunedImages: guard.prunedImages,
        },
      });
      return;
    }

    const startedAt = Date.now();
    try {
      const upstream = await fetch(`${settings.upstreamBaseUrl}/responses`, {
        method: "POST",
        headers: {
          accept: req.headers.accept ?? "application/json",
          authorization,
          "content-type": "application/json",
          "user-agent":
            req.headers["user-agent"] ?? "codex-deepseek-413-guard/1.0",
        },
        body: serializedBody,
        signal: AbortSignal.timeout(settings.upstreamTimeoutMs),
      });

      const responseHeaders = {
        "content-type":
          upstream.headers.get("content-type") ??
          "application/json; charset=utf-8",
        "cache-control": "no-store",
      };
      const requestId = upstream.headers.get("x-request-id");
      if (requestId) responseHeaders["x-request-id"] = requestId;
      res.writeHead(upstream.status, responseHeaders);

      if (upstream.body) {
        await pipeline(Readable.fromWeb(upstream.body), res);
      } else {
        res.end();
      }

      console.log(
        `[guard] upstream status=${upstream.status} ms=${Date.now() - startedAt}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown upstream error.";
      console.error(`[guard] upstream error: ${message}`);
      if (!res.headersSent) {
        json(res, 502, {
          error: { message, type: "upstream_error" },
        });
      } else {
        res.destroy(error);
      }
    }
  });
}

function removePidFile() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, "utf8"));
    if (pid === process.pid) fs.rmSync(PID_PATH, { force: true });
  } catch {
    // Ignore cleanup failures during shutdown.
  }
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replaceAll("\\", "/").split("/").pop(),
  )
) {
  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  const server = createGuardServer();
  server.listen(PORT, HOST, () => {
    fs.writeFileSync(PID_PATH, `${process.pid}\n`, "utf8");
    console.log(`[guard] listening on http://${HOST}:${PORT}`);
  });
  process.on("exit", removePidFile);
  process.on("SIGINT", () => server.close(removePidFile));
  process.on("SIGTERM", () => server.close(removePidFile));
}
