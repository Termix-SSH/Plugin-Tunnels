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

const manifest = manifestJson as unknown as PluginManifest;

const tunnel = (sourcePort: number, endpointPort: number) => ({
  scope: "s2s",
  mode: "local",
  sourcePort,
  endpointHost: "db",
  endpointPort,
  maxRetries: 3,
  retryInterval: 10,
  autoStart: false,
});

const webHost = {
  id: "7",
  name: "web",
  ip: "10.0.0.5",
  port: 22,
  username: "root",
  enableSsh: true,
  pluginSettings: { tunnels: { enableTunnel: true } },
};

const offHost = {
  ...webHost,
  id: "8",
  name: "quiet",
  pluginSettings: { tunnels: { enableTunnel: false } },
};

function stubApi(): PluginApiClient {
  return {
    get: vi.fn(async (url: string) => ({
      data:
        url === "/saved"
          ? [{ hostId: 7, connections: [tunnel(8080, 5432), tunnel(9090, 80)] }]
          : {},
    })),
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
});

async function open(api: PluginApiClient, hosts = [webHost, offHost]) {
  rendered = await renderWithApp(plugin, { manifest, locales, api, hosts });
  rendered.renderTab("tunnel", { host: webHost });
  await screen.findByText("db:5432");
}

describe("tunnel list", () => {
  it("adds one new tunnel and keeps the others", async () => {
    const api = stubApi();
    await open(api);

    fireEvent.click(screen.getByText(locales.tunnels.addTunnel));
    expect(await screen.findByText("New tunnel on web")).toBeTruthy();
    fireEvent.click(screen.getByText(/^save$/i));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [url, body] = (api.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/saved/7");
    expect(body.connections).toHaveLength(3);
    expect(body.connections[0]).toMatchObject({ sourcePort: 8080 });
  });

  it("edits just the tunnel whose button was pressed", async () => {
    const api = stubApi();
    await open(api);

    fireEvent.click(screen.getAllByTitle(locales.tunnels.edit)[1]);
    expect(await screen.findByText("Edit tunnel on web")).toBeTruthy();
    const port = screen.getByDisplayValue("80");
    fireEvent.change(port, { target: { value: "8443" } });
    fireEvent.click(screen.getByText(/^save$/i));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [, body] = (api.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body.connections).toHaveLength(2);
    expect(body.connections[0]).toMatchObject({ endpointPort: 5432 });
    expect(body.connections[1]).toMatchObject({ endpointPort: 8443 });
  });

  it("filters with the search box", async () => {
    await open(stubApi());
    fireEvent.change(screen.getByPlaceholderText(locales.tunnels.search), {
      target: { value: "9090" },
    });
    expect(screen.queryByText("db:5432")).toBeNull();
    expect(screen.getByText("db:80")).toBeTruthy();
  });

  it("only offers hosts with tunnels turned on", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi(),
      hosts: [webHost, offHost],
    });
    rendered.renderTab("tunnel", {});
    await screen.findByText("db:5432");
    expect(screen.queryByText("quiet")).toBeNull();
  });
});
