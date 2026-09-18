import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../src/config/load.js";
import { validateConfig } from "../../src/config/validate.js";
import { setup } from "./helpers.js";

test("invalid Web model providers are rejected before overwriting a restartable config", async () => {
  const h = setup(false, false);
  try {
    for (const provider of ["openai-responses", "anthropic-messages"]) {
      await h.app.dispatch("config.ai", {
        enabled: false,
        provider,
        model: "test-model",
        baseUrl: "https://model.example.invalid/v1",
        apiKey: "test-only-key",
      });
      const path = join(h.directory, "config.toml");
      const before = await readFile(path, "utf8");
      for (const invalid of ["openai", "anthropic", "unknown"]) {
        await assert.rejects(
          h.app.dispatch("config.ai", {
            enabled: false,
            provider: invalid,
            model: "invalid-overwrite",
            baseUrl: "https://model.example.invalid/v1",
          }),
          { code: "ai_provider" },
        );
        assert.equal(await readFile(path, "utf8"), before);
      }
      const reloaded = loadConfig({
        stateDir: h.directory,
        cwd: h.directory,
        home: h.directory,
        env: {},
      });
      assert.equal(reloaded.ai.provider, provider);
      assert.equal(reloaded.ai.model, "test-model");
      validateConfig(reloaded);
    }
  } finally {
    await h.close();
  }
});

test("runtime config validation rejects unsupported providers even when AI is disabled", async () => {
  const h = setup(false, false);
  try {
    Object.assign(h.config.ai, { provider: "openai" });
    assert.throws(() => validateConfig(h.config), { code: "ai_provider" });
  } finally {
    await h.close();
  }
});
