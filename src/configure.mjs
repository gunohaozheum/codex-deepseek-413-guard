import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectDeepSeekProvider,
  setDeepSeekBaseUrl,
} from "./provider-config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SETTINGS_PATH = path.join(ROOT, "guard.config.json");
const PAUSE_FLAG_PATH = path.join(ROOT, "runtime", "paused.flag");
const OFFICIAL_BASE_URL = "https://api.deepseek.com/";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function configPath() {
  const explicit = argValue("--config");
  if (explicit) return path.resolve(explicit);
  const codexHome =
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "config.toml");
}

function settings() {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
}

function localBaseUrl() {
  const explicit = argValue("--base-url");
  if (explicit) return explicit;
  const config = settings();
  return `http://${config.host}:${config.port}/v1`;
}

function readConfigText() {
  const target = configPath();
  if (!fs.existsSync(target)) {
    throw new Error(`Codex config was not found: ${target}`);
  }
  return { target, text: fs.readFileSync(target, "utf8") };
}

function writeConfigText(target, text) {
  fs.writeFileSync(target, text, "utf8");
}

function status() {
  const { target, text } = readConfigText();
  const provider = inspectDeepSeekProvider(text);
  return {
    configPath: target,
    providerFound: provider.found,
    baseUrl: provider.baseUrl,
    officialBaseUrl: OFFICIAL_BASE_URL,
    expectedGuardedBaseUrl: localBaseUrl(),
    paused: fs.existsSync(PAUSE_FLAG_PATH),
  };
}

const action = process.argv[2] ?? "status";

try {
  if (action === "enable") {
    const { target, text } = readConfigText();
    const updated = setDeepSeekBaseUrl(text, localBaseUrl());
    writeConfigText(target, updated);
    console.log(
      JSON.stringify({
        ok: true,
        configPath: target,
        baseUrl: localBaseUrl(),
      }),
    );
  } else if (action === "disable") {
    const { target, text } = readConfigText();
    const updated = setDeepSeekBaseUrl(text, OFFICIAL_BASE_URL);
    writeConfigText(target, updated);
    console.log(
      JSON.stringify({
        ok: true,
        configPath: target,
        baseUrl: OFFICIAL_BASE_URL,
      }),
    );
  } else if (action === "pause") {
    fs.mkdirSync(path.dirname(PAUSE_FLAG_PATH), { recursive: true });
    fs.writeFileSync(PAUSE_FLAG_PATH, "paused\n", "utf8");
    console.log(JSON.stringify({ ok: true, paused: true }));
  } else if (action === "resume") {
    fs.rmSync(PAUSE_FLAG_PATH, { force: true });
    console.log(JSON.stringify({ ok: true, paused: false }));
  } else if (action === "cleanup") {
    fs.rmSync(PAUSE_FLAG_PATH, { force: true });
    fs.rmSync(path.join(ROOT, "runtime", "proxy.pid"), { force: true });
    console.log(JSON.stringify({ ok: true, cleaned: true }));
  } else if (action === "status") {
    console.log(JSON.stringify(status()));
  } else if (action === "settings") {
    console.log(JSON.stringify(settings()));
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      code: error.code ?? "CONFIGURATION_ERROR",
      message: error.message,
    }),
  );
  process.exitCode = 1;
}
