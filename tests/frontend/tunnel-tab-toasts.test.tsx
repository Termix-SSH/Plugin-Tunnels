import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/frontend")>()),
  useToast: () => toast,
}));

const webHost = {
  id: "7",
  name: "web",
  ip: "10.0.0.5",
  port: 22,
  username: "root",
  enableSsh: true,
  pluginSettings: {
    tunnels: {
      enableTunnel: true,
      tunnelConnections: [
        {
          scope: "s2s",
          mode: "local",
          sourcePort: 8080,
          endpointHost: "db",
          endpointPort: 5432,
          maxRetries: 3,
          retryInterval: 10,
          autoStart: false,
        },
      ],
    },
  },
};

function stubApi(): PluginApiClient {
  return {
    get: vi.fn(async () => ({ data: {} })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
  } as PluginApiClient;
}

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.clearAllMocks();
});

describe("tunnel tab toasts", () => {
  it("calls a started server tunnel a tunnel, not a client tunnel", async () => {
    rendered = await renderWithApp(plugin, {
      manifest: manifestJson as unknown as PluginManifest,
      locales,
      api: stubApi(),
      hosts: [webHost],
    });
    rendered.renderTab("tunnel", { host: webHost });
    await screen.findByText("db:5432");

    fireEvent.click(screen.getByText(/start/i));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Tunnel started"),
    );
    expect(toast.success).not.toHaveBeenCalledWith("Client tunnel started");
  });
});
