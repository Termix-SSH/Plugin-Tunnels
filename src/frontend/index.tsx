import type { ComponentType } from "react";
import { Network } from "lucide-react";
import type { TabProps, TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { TunnelAuthPrompts } from "./TunnelAuthPrompts";
import { TunnelTab } from "./TunnelTab";
import { hostTunnelsEnabled, hostTunnelsPanelEnabled } from "./host-tunnels";
import {
  TunnelsCard,
  TunnelsCompanion,
  useTunnelsCompanionDefaults,
} from "./TunnelsCompanion";
import { TunnelsHome } from "./TunnelsHome";
import { HostTunnelsSection } from "./HostTunnelsSection";
import {
  PortForwardingPanel,
  TunnelStandalone,
  TunnelWidget,
  TunnelWidgetEditForm,
} from "./views";
import { setTunnelsApi } from "./api";
import {
  localC2SAvailable,
  setLocalC2S,
  startLocalAutoStart,
} from "./c2s-local-api";
import { ActiveTunnelsCounter } from "./ActiveTunnelsCounter";

// Matches the homepage canvas grid.
const GRID_SIZE = 30;

function TunnelTabView({ host }: TabProps) {
  return <TunnelsHome host={host} />;
}

export function activate(app: TermixApp): void {
  setLocalC2S(app);
  app.onDispose(() => setLocalC2S(null));
  // Starts the client tunnels set to start on their own, in the desktop app.
  if (localC2SAvailable()) void startLocalAutoStart().catch(() => {});
  app.registerSlotContribution("shell.overlay", {
    actionId: "tunnels.authPrompts",
    titleKey: "tunnels.authTitle",
    kind: "component",
    component: TunnelAuthPrompts as ComponentType<Record<string, unknown>>,
  });
  // apiFor("remote") hands back app.api itself outside the desktop app.
  const remote = app.apiFor("remote");
  setTunnelsApi(app.api, {
    stream: (init) => app.fetch("/status/stream", init),
    remote: remote === app.api ? null : remote,
  });
  app.onDispose(() => setTunnelsApi(null));

  // Keeps the "tunnel" tab type and ?view=tunnel links from before the
  // conversion, so saved layouts and recent activity still open here.
  app.registerTab("tunnel", TunnelTabView as ComponentType<TabProps>, {
    icon: Network,
    titleKey: "nav.tunnels",
    persistent: true,
    hostless: true,
    standalone: TunnelStandalone,
    activityTypes: ["tunnel"],
  });

  app.registerHostAction({
    id: "tunnel",
    titleKey: "nav.tunnels",
    icon: Network,
    kind: "open",
    order: 40,
    tabType: "tunnel",
    copyUrlView: "tunnel",
    when: (host) => host.enableSsh !== false && hostTunnelsEnabled(host),
  });

  app.registerHostEditorSection({
    id: "tunnels",
    group: "ssh",
    titleKey: "hosts.tabTunnels",
    icon: Network,
    order: 20,
    component: HostTunnelsSection,
  });

  app.registerPanel("port-forwarding", PortForwardingPanel);
  // The Tunnels tab itself: SSH tunnels and gateways.
  app.registerRailItem({
    id: "tunnel",
    icon: Network,
    titleKey: "nav.tunnels",
    kind: "tab",
    group: "tools",
    after: "credentials",
    permission: "use",
  });
  app.registerRailItem({
    id: "port-forwarding",
    icon: Network,
    titleKey: "nav.portForwarding",
    kind: "panel",
    electronOnly: true,
    separatorAfter: true,
    after: "credentials",
    permission: "use",
  });

  app.registerExtension("homepage.widgets", {
    id: "tunnel_widget",
    name: "Tunnel Manager",
    description: "Embedded SSH tunnel manager for a configured host",
    category: "system",
    icon: <Network size={14} />,
    defaultConfig: { hostId: 0 },
    defaultSize: { w: GRID_SIZE * 16, h: GRID_SIZE * 10 },
    minSize: { w: GRID_SIZE * 8, h: GRID_SIZE * 6 },
    components: { view: TunnelWidget, editForm: TunnelWidgetEditForm },
  });

  // The dashboard's active tunnel counter.
  app.registerAction(
    "tunnels.open",
    (() => app.tabs.openSingletonTab("tunnel")) as never,
    { permission: "use" },
  );
  app.registerSlotContribution("dashboard.counters", {
    actionId: "tunnels.open",
    titleKey: "tunnels.activeTunnels",
    kind: "component",
    component: (() => (
      <ActiveTunnelsCounter
        onOpen={() => void app.tabs.openSingletonTab("tunnel")}
      />
    )) as never,
  });

  app.registerDashboardCard({
    id: "tunnels",
    titleKey: "nav.tunnels",
    defaultPanel: "side",
    defaultHeight: 220,
    frame: "framed",
    component: TunnelsCard,
  });

  // Older cores have no panels beside tabs.
  if (typeof app.registerCompanion === "function") {
    // Companion filters run synchronously, so the permission is read once here.
    let canUse = true;
    void app.hasPermission("use").then((allowed) => {
      canUse = allowed;
    });
    app.registerCompanion("tunnels", TunnelsCompanion, {
      icon: Network,
      titleKey: "nav.tunnels",
      order: 80,
      tabTypes: ["terminal"],
      when: (_tab, host) =>
        canUse && host?.enableSsh !== false && hostTunnelsPanelEnabled(host),
      useDefaults: useTunnelsCompanionDefaults,
    });
    app.registerAction("tunnels.togglePanel", ((
      _handle: unknown,
      tab: unknown,
    ) => app.toggleCompanion(tab as never, "tunnels")) as never);
    app.registerSlotContribution("tab.menu", {
      actionId: "tunnels.togglePanel",
      titleKey: "companion.toggle",
      icon: Network,
      kind: "button",
      order: 11,
      when: (context) => {
        const tab = context.tab as {
          type?: string;
          host?: unknown;
          hostConfig?: unknown;
        } | null;
        return (
          tab?.type === "terminal" &&
          hostTunnelsPanelEnabled((tab.host ?? tab.hostConfig) as never)
        );
      },
    });
  }
}
