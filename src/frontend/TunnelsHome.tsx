import { useCallback, useEffect, useState } from "react";
import { useExtensions, useTranslation, type PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import { TabStrip } from "@termix-ssh/plugin-sdk/ui";
import { TunnelTab } from "./TunnelTab";
import { GatewaysView } from "./GatewaysView";
import { onTunnelViewRequest, tunnelViews } from "./tunnel-views";

const STORAGE_KEY = "tunnels.view";

function storedView(): string {
  try { return localStorage.getItem(STORAGE_KEY) || "ssh"; }
  catch { return "ssh"; }
}

/** SSH, gateways and sections provided by independent tunnel plugins. */
export function TunnelsHome({ host, requestedView }: {
  host?: PluginHostRecord | null;
  requestedView?: string;
}) {
  const { t } = useTranslation();
  const extensions = tunnelViews(useExtensions("tunnels.views"));
  const [selected, setSelected] = useState(() => requestedView ?? storedView());
  const extension = extensions.find((entry) => entry.id === selected);
  // Keep the desired id while plugins load, but never render an absent provider.
  const view = selected === "gateways" ? "gateways" : extension ? extension.id : "ssh";

  const change = useCallback((next: string) => {
    setSelected(next);
    try { localStorage.setItem(STORAGE_KEY, next); }
    catch { /* Remembering the view is optional. */ }
  }, []);

  useEffect(() => {
    if (requestedView) setSelected(requestedView);
  }, [requestedView]);
  useEffect(() => onTunnelViewRequest((request) => {
    if (
      request.viewId === requestedView &&
      String(request.hostId ?? "") === String(host?.id ?? "")
    ) change(request.viewId);
  }), [host?.id, requestedView, change]);

  const switcher = (
    <TabStrip
      tabs={[
        { id: "ssh", label: t("tunnels.sshTunnels") },
        { id: "gateways", label: t("gateways.title") },
        ...extensions.map((entry) => ({ id: entry.id, label: entry.title })),
      ]}
      activeTab={view}
      onTabChange={change}
    />
  );

  if (view === "gateways") return <GatewaysView switcher={switcher} />;
  if (extension && view === extension.id) {
    const View = extension.components.view;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <nav className="shrink-0 overflow-x-auto p-2.5" aria-label={t("nav.tunnels")}>{switcher}</nav>
        <div className="min-h-0 flex-1 overflow-hidden"><View host={host} /></div>
      </div>
    );
  }
  return <TunnelTab host={host ?? undefined} switcher={switcher} />;
}
