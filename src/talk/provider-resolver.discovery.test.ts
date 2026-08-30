import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { withEnv } from "../test-utils/env.js";
import { listRealtimeVoiceProviders } from "./provider-registry.js";
import { resolveConfiguredRealtimeVoiceProvider } from "./provider-resolver.js";

function withVoiceProviders(
  run: (cfg: OpenClawConfig) => void,
  policy: OpenClawConfig["plugins"] = {},
) {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const workspace = path.join(root, "workspace");
  mkdirSafe(workspace);
  for (const [id, order] of [
    ["active-voice", 20],
    ["configured-voice", 10],
  ] as const) {
    const plugin = writePlugin({
      id,
      dir: path.join(root, "extensions", id),
      filename: "index.cjs",
      body: `module.exports = { id: "${id}", register(api) {
        api.registerRealtimeVoiceProvider({
          id: "${id}", aliases: ["${id}-alias"], label: "${id}", autoSelectOrder: ${order},
          resolveConfig: ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
          isConfigured: ({ providerConfig }) => providerConfig.ready === true ||
            process.env.VOICE_DISCOVERY_TEST_CONFIGURED_PROVIDER === "${id}",
          createBridge: () => { throw new Error("provider discovery must not start media"); },
        });
      } };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
        contracts: { realtimeVoiceProviders: [id] },
      }),
    );
    fs.writeFileSync(
      path.join(plugin.dir, "package.json"),
      JSON.stringify({ openclaw: { extensions: ["./index.cjs"] } }),
    );
  }
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace } },
    plugins: {
      allow: ["active-voice", "configured-voice"],
      ...policy,
      entries: {
        "active-voice": { enabled: true },
        "configured-voice": { enabled: true },
        ...policy?.entries,
      },
    },
  };
  return withEnv(
    {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    () => run(cfg),
  );
}

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("realtime voice provider discovery", () => {
  it.each([false, true])(
    "discovers configured candidates when the active provider is configured=%s",
    (activeReady) => {
      withVoiceProviders((cfg) => {
        const registry = loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
        expect(registry.realtimeVoiceProviders.map((entry) => entry.provider.id)).toEqual([
          "active-voice",
        ]);

        const result = resolveConfiguredRealtimeVoiceProvider({
          cfg,
          providerConfigs: {
            "active-voice": { ready: activeReady },
            "configured-voice": { ready: true },
          },
        });

        expect(result.provider.id).toBe("configured-voice");
        expect(result.providerConfig).toEqual({ ready: true, resolved: true });
        // Per-call discovery must not broaden catalogs or replace active objects.
        expect(listRealtimeVoiceProviders(cfg)).toEqual(
          registry.realtimeVoiceProviders.map((entry) => entry.provider),
        );
      });
    },
  );

  it.each([undefined, "configured-voice"])(
    "selects a configured provider from a cold registry with explicit selection %s",
    (configuredProviderId) => {
      withVoiceProviders((cfg) => {
        const result = resolveConfiguredRealtimeVoiceProvider({
          cfg,
          configuredProviderId,
          providerConfigs: { "configured-voice": { ready: true } },
        });
        expect(result.provider.id).toBe("configured-voice");
      });
    },
  );

  it("keeps environment-configured providers eligible with an unconfigured default map", () => {
    withEnv({ VOICE_DISCOVERY_TEST_CONFIGURED_PROVIDER: "active-voice" }, () => {
      withVoiceProviders((cfg) => {
        const result = resolveConfiguredRealtimeVoiceProvider({
          cfg,
          providerConfigs: { "configured-voice": { ready: false } },
        });
        expect(result.provider.id).toBe("active-voice");
      });
    });
  });

  it("extends a cold config-derived discovery scope with per-call candidates", () => {
    withVoiceProviders((cfg) => {
      cfg.talk = { realtime: { provider: "active-voice" } };
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providerConfigs: { "configured-voice": { ready: true } },
      });
      expect(result.provider.id).toBe("configured-voice");
    });
  });

  it.each([
    ["active-voice", "configured-voice-alias"],
    ["configured-voice-alias", "active-voice"],
  ])("discovers mixed canonical and runtime-alias candidates %s + %s", (scopeId, candidateId) => {
    withEnv({ VOICE_DISCOVERY_TEST_CONFIGURED_PROVIDER: "configured-voice" }, () => {
      withVoiceProviders((cfg) => {
        cfg.talk = { realtime: { provider: scopeId } };
        const result = resolveConfiguredRealtimeVoiceProvider({
          cfg,
          providerConfigs: { [candidateId]: {} },
        });
        expect(result.provider.id).toBe("configured-voice");
      });
    });
  });

  it.each([
    { label: "disabled", policy: { entries: { "configured-voice": { enabled: false } } } },
    { label: "denied", policy: { deny: ["configured-voice"] } },
    { label: "not allowed", policy: { allow: ["active-voice"] } },
  ])("does not auto-select a $label configured owner", ({ policy }) => {
    withVoiceProviders((cfg) => {
      loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providerConfigs: {
          "active-voice": { ready: true },
          "configured-voice": { ready: true },
        },
      });
      expect(result.provider.id).toBe("active-voice");
    }, policy);
  });

  it("does not discover configured owners when plugins are globally disabled", () => {
    withVoiceProviders(
      (cfg) => {
        expect(() =>
          resolveConfiguredRealtimeVoiceProvider({
            cfg,
            providerConfigs: { "configured-voice": { ready: true } },
          }),
        ).toThrow("No realtime voice provider registered");
      },
      { enabled: false },
    );
  });

  it("keeps a caller-supplied provider list authoritative", () => {
    withVoiceProviders((cfg) => {
      const registry = loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
      const result = resolveConfiguredRealtimeVoiceProvider({
        cfg,
        providers: registry.realtimeVoiceProviders.map((entry) => entry.provider),
        providerConfigs: {
          "active-voice": { ready: true },
          "configured-voice": { ready: true },
        },
      });
      expect(result.provider.id).toBe("active-voice");
    });
  });
});
