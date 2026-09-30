import type { T3NativeEnvironment } from "../../src/lib/t3-native.ts";
export const nativeConfig = () => ({
  auth: { sessionMethods: ["bearer-access-token"] },
  settings: { defaultModelSelection: null },
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        {
          slug: "catalog-default",
          isDefault: true,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select",
                currentValue: "medium",
                options: [{ id: "low" }, { id: "medium", isDefault: true }, { id: "high" }],
              },
            ],
          },
        },
      ],
    },
  ],
});
export const nativeEnvironment = (): T3NativeEnvironment => ({
  baseDir: "/t3",
  cli: "t3",
  origin: "http://127.0.0.1:3773",
  environmentId: "environment-1",
  serverVersion: "0.0.43",
  settings: {},
  config: nativeConfig(),
});
