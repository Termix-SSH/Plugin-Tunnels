import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type {
  CompanionProps,
  PluginApiClient,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { TunnelsCompanion } from "../../src/frontend/TunnelsCompanion";
import { hostTunnelsPanelEnabled } from "../../src/frontend/host-tunnels";
import { resetSavedTunnels } from "../../src/frontend/saved-tunnels";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  resetSavedTunnels();
});

const savedTunnel = {
  scope: "s2s",
  mode: "local",
  sourcePort: 8080,
  endpointHost: "db",
  endpointPort: 5432,
  maxRetries: 3,
  retryInterval: 10,
  autoStart: false,
};

const webHost = {
  id: "7",
  name: "web",
  ip: "10.0.0.5",
  port: 22,
  username: "root",
  enableSsh: true,
  pluginSettings: { tunnels: { enableTunnel: true } },
};

function stubApi(): PluginApiClient {
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/saved" ? [{ hostId: 7, connections: [savedTunnel] }] : {},
    })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
  } as unknown as PluginApiClient;
}

const withCompanion = {
  activate(app: TermixApp) {
    plugin.activate(app);
    app.registerSlotContribution("test.companion", {
      actionId: "test.companion",
      titleKey: "nav.tunnels",
      kind: "component",
      component: (() => (
        <TunnelsCompanion
          {...({
            tab: { id: "tab-1", type: "terminal", label: "web", host: webHost },
            host: webHost,
            getHandle: () => null,
            side: "right",
            isVisible: true,
            close: () => {},
            setSide: () => {},
          } as unknown as CompanionProps)}
        />
      )) as never,
    });
  },
};

describe("tunnels panel and card", () => {
  it("follows the host's tunnel and panel switches", () => {
    expect(hostTunnelsPanelEnabled(webHost as never)).toBe(true);
    expect(
      hostTunnelsPanelEnabled({
        ...webHost,
        pluginSettings: { tunnels: { enableTunnel: true, showPanel: false } },
      } as never),
    ).toBe(false);
  });

  it("starts a tunnel from the panel beside a terminal", async () => {
    const api = stubApi();
    rendered = await renderWithApp(withCompanion, {
      manifest,
      locales,
      api,
      hosts: [webHost],
    });
    rendered.renderSlot("test.companion");
    expect(await screen.findByText(/8080/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/start/i));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/connect",
        expect.objectContaining({ sourceHostId: 7, tunnelIndex: 0 }),
      ),
    );
  });

  it("lists every host's tunnels on the dashboard card", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi(),
      hosts: [webHost],
    });
    rendered.renderDashboardCard("tunnels");
    expect(await screen.findByText(/web \| local/)).toBeTruthy();
  });
});
