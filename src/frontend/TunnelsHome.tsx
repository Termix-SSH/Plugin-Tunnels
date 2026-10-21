import { useState } from "react";
import {
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import { Segmented } from "@termix-ssh/plugin-sdk/ui";
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
    <Segmented<View>
      value={view}
      onChange={change}
      options={[
        { value: "ssh", label: t("tunnels.sshTunnels") },
        { value: "gateways", label: t("gateways.title") },
      ]}
    />
  );

  return view === "ssh" ? (
    <TunnelTab host={host ?? undefined} switcher={switcher} />
  ) : (
    <GatewaysView switcher={switcher} />
  );
}
