import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithApp, type RenderedPluginApp } from "@termix-ssh/plugin-sdk/testing";
import { usePluginApi, useTranslation, type PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";
import locales from "../../locales/en.json";

const apps: RenderedPluginApp[] = [];
const host = { id: "7", name: "test-host", ip: "192.0.2.7", port: 22, username: "root" };
function api() {
  return { get: vi.fn(async () => ({ data: [] })), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as PluginApiClient;
}
function ProviderView() {
  const { t } = useTranslation();
  const ownApi = usePluginApi();
  return <section><h2>{t("heading")}</h2><button onClick={() => void ownApi.get("/check")}>Check provider</button></section>;
}
async function setup(id = "vpn-fixture.main", permissions = ["tunnels.use"]) {
  const tunnelApi = api();
  const providerApi = api();
  const tunnels = await renderWithApp(plugin, {
    manifest: manifest as PluginManifest, locales, hosts: [host],
    permissions, api: tunnelApi,
  });
  apps.push(tunnels);
  const provider = await renderWithApp({
    activate(app) { app.registerExtension("tunnels.views", { id, title: "Private VPN", components: { view: ProviderView } }); },
  }, {
    manifest: { id: "vpn-fixture", capabilities: ["ui:surface"], contributes: { uses: ["tunnels.views"] } },
    hosts: [host], permissions, locales: { heading: "Provider translated" }, api: providerApi,
  });
  apps.push(provider);
  return { tunnels, provider, tunnelApi, providerApi };
}
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await act(() => app.deactivate());
  localStorage.clear();
});
describe("generic Tunnels sections", () => {
  it.each([
    { permissions: ["tunnels.use"], available: ["tunnels.views"] },
    { permissions: [], available: [] },
  ])("advertises a usable container only with its own use permission: $permissions", async ({ permissions, available }) => {
    const { tunnels } = await setup("vpn-fixture.main", permissions);
    tunnels.renderSlot("shell.overlay");
    expect(tunnels.registered.extensions("tunnels.containers")).toEqual(available);
    await act(() => tunnels.deactivate());
    expect(tunnels.registered.extensions("tunnels.containers")).toEqual([]);
  });

  it("renders another provider in its own scope and retains navigation when it is removed", async () => {
    const { tunnels, provider, tunnelApi, providerApi } = await setup();
    tunnels.renderTab("tunnel", { host });
    fireEvent.click(screen.getByRole("button", { name: "Private VPN" }));
    expect(await screen.findByText("Provider translated")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check provider" }));
    expect(providerApi.get).toHaveBeenCalledWith("/check");
    expect(tunnelApi.get).not.toHaveBeenCalledWith("/check");
    await act(() => provider.deactivate());
    expect(await screen.findByText("No SSH Tunnels")).toBeTruthy();
    expect(screen.queryByText("Provider translated")).toBeNull();
  });
  it("reveals the requested section again when a matching open tab is reused", async () => {
    const { tunnels, provider } = await setup();
    tunnels.renderTab("tunnel", { host, tab: { id: "tunnel-7", type: "tunnel", host, data: { tunnelView: "vpn-fixture.main" } } });
    expect(await screen.findByText("Provider translated")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "SSH tunnels" }));
    expect(screen.queryByText("Provider translated")).toBeNull();
    await act(() => tunnels.app.invokeAction("tunnels.openView", { viewId: "vpn-fixture.main", hostId: host.id }));
    expect(await screen.findByText("Provider translated")).toBeTruthy();
    expect(provider.shellCalls).toContainEqual({
      method: "openTab", args: [expect.objectContaining({ id: host.id }), "tunnel", { data: { tunnelView: "vpn-fixture.main" } }],
    });
    await expect(tunnels.app.invokeAction("tunnels.openView", { viewId: "missing.main" })).resolves.toBe(false);
    await expect(tunnels.app.invokeAction("tunnels.openView", { viewId: "vpn-fixture.main", hostId: "missing" })).resolves.toBe(false);
  });
  it("ignores a contribution pretending to use another provider's namespace", async () => {
    const { tunnels } = await setup("somebody-else.main");
    tunnels.renderTab("tunnel", { host });
    expect(screen.queryByRole("button", { name: "Private VPN" })).toBeNull();
    await expect(tunnels.app.invokeAction("tunnels.openView", { viewId: "somebody-else.main" })).resolves.toBe(false);
  });
});
