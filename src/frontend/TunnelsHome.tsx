import { useState } from "react";
import {
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import { TabStrip } from "@termix-ssh/plugin-sdk/ui";
import { TunnelTab } from "./TunnelTab";
import { GatewaysView } from "./GatewaysView";

type View = "ssh" | "gateways";

const STORAGE_KEY = "tunnels.view";

function storedView(): View {
  try {
    return localStorage.getItem(STORAGE_KEY) === "gateways"
      ? "gateways"
      : "ssh";
  } catch {
    return "ssh";
  }
}

/** The Tunnels tab: SSH tunnels and gateways. */
export function TunnelsHome({ host }: { host?: PluginHostRecord | null }) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>(storedView);

  const change = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Remembering the view is optional.
    }
  };

  const switcher = (
    <TabStrip
      tabs={[
        { id: "ssh", label: t("tunnels.sshTunnels") },
        { id: "gateways", label: t("gateways.title") },
      ]}
      activeTab={view}
      onTabChange={(id) => change(id as View)}
    />
  );

  return view === "ssh" ? (
    <TunnelTab host={host ?? undefined} switcher={switcher} />
  ) : (
    <GatewaysView switcher={switcher} />
  );
}
