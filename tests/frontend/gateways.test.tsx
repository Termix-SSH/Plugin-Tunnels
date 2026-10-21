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
import { firewallPorts, parsePortList } from "../../src/frontend/gateway-utils";
import type { Gateway } from "../../src/shared/types";

const manifest = manifestJson as unknown as PluginManifest;

const gateway: Gateway = {
  id: 1,
  name: "Home lab",
  privateHostId: 7,
  publicHostId: 8,
  endpoint: "203.0.113.5",
  listenPort: 51831,
  scanEnabled: false,
  scanInterval: 10,
  autoEnable: false,
  scanGuests: true,
  sourceHostIds: [],
  ignoredPorts: [],
  publicIp: "10.77.2.1",
  privateIp: "10.77.2.2",
  ports: [
    {
      id: 1,
      gatewayId: 1,
      proto: "both",
      publicPort: 7777,
      targetHost: "",
      targetPort: 7777,
      label: "",
      source: "manual",
      sourceHostId: null,
      enabled: true,
    },
    {
      id: 2,
      gatewayId: 1,
      proto: "tcp",
      publicPort: 25565,
      targetHost: "",
      targetPort: 25565,
      label: "",
      source: "scan",
      sourceHostId: 7,
      enabled: false,
    },
  ],
  status: {
    state: "up",
    message: null,
    handshakeAge: 12,
    checkedAt: null,
    lastScanAt: null,
    ports: {},
  },
};

function stubApi(gateways: Gateway[]): PluginApiClient {
  return {
    get: vi.fn(async (url: string) => ({
      data: url === "/gateways" ? gateways : url === "/saved" ? [] : {},
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
  localStorage.clear();
});

describe("gateways", () => {
  it("shows the gateways on the Tunnels tab", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi([gateway]),
    });
    rendered.renderTab("tunnel", {});
    fireEvent.click(screen.getByText(locales.gateways.title));

    expect(await screen.findByText("Home lab")).toBeTruthy();
    expect(screen.getByText(locales.gateways.state.up)).toBeTruthy();
  });

  it("explains an empty list", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: stubApi([]),
    });
    rendered.renderTab("tunnel", {});
    fireEvent.click(screen.getByText(locales.gateways.title));
    expect(await screen.findByText(locales.gateways.empty)).toBeTruthy();
  });

  it("turns a port on or off through the api", async () => {
    const api = stubApi([gateway]);
    rendered = await renderWithApp(plugin, { manifest, locales, api });
    rendered.renderTab("tunnel", {});
    fireEvent.click(screen.getByText(locales.gateways.title));
    fireEvent.click(await screen.findByText("Home lab"));

    expect(await screen.findByText(/25565/)).toBeTruthy();
    const switches = await screen.findAllByRole("switch");
    fireEvent.click(switches[switches.length - 1]);
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
  });
});

describe("gateway helpers", () => {
  it("lists the public ports to open", () => {
    expect(firewallPorts(gateway)).toEqual([
      "tcp 7777",
      "udp 7777",
      "udp 51831",
    ]);
  });

  it("reads a list of ports", () => {
    expect(parsePortList("22, 8080 99999 abc 25565")).toEqual([
      22, 8080, 25565,
    ]);
  });
});
