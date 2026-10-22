import { useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import {
  useToast,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import { ListRow, ListRowAction, PanelList } from "@termix-ssh/plugin-sdk/ui";
import {
  connectTunnel,
  disconnectTunnel,
  subscribeTunnelStatuses,
  type TunnelStatusMap,
} from "./api";
import { connectRequestFor, tunnelMode } from "./host-tunnels";
import { useSavedTunnels } from "./saved-tunnels";
import {
  STATUS_TEXT_KEYS,
  statusLabel,
  tunnelEntries,
  type TunnelEntry,
} from "./TunnelTab";

const TONES = {
  CONNECTED: "brand",
  CONNECTING: "warning",
  WAITING: "warning",
  ERROR: "destructive",
  DISCONNECTED: "muted",
} as const;

/** A compact list of tunnels with live status and start or stop. */
export function TunnelList({
  hosts,
  showHost,
  isVisible,
  empty,
}: {
  hosts: PluginHostRecord[];
  showHost: boolean;
  isVisible: boolean;
  empty: React.ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const saved = useSavedTunnels();
  const [statuses, setStatuses] = useState<TunnelStatusMap>({});
  const [acting, setActing] = useState("");

  useEffect(() => {
    if (!isVisible) return;
    return subscribeTunnelStatuses(setStatuses);
  }, [isVisible]);

  const entries = hosts.flatMap((host) => tunnelEntries(host, saved.byHost));

  const toggle = async (entry: TunnelEntry, running: boolean) => {
    setActing(entry.name);
    try {
      if (running) {
        await disconnectTunnel(entry.name);
        toast.info(t("tunnels.tunnelStopped"));
      } else {
        await connectTunnel(
          connectRequestFor(entry.host, entry.index, entry.tunnel),
        );
        toast.success(t("tunnels.tunnelStarted"));
      }
    } catch {
      toast.error(t("tunnels.manualControlError"));
    } finally {
      setActing("");
    }
  };

  if (!saved.loaded) {
    return (
      <p className="p-2 text-xs text-muted-foreground">{t("common.loading")}</p>
    );
  }

  return (
    <PanelList empty={empty}>
      {entries.map((entry, index) => {
        const label = statusLabel(statuses[entry.name]);
        const running = label !== "DISCONNECTED" && label !== "ERROR";
        const mode = tunnelMode(entry.tunnel);
        const destination =
          mode === "dynamic"
            ? t("tunnels.socksProxy")
            : `${entry.tunnel.endpointHost ?? ""}:${entry.tunnel.endpointPort}`;
        return (
          <ListRow
            key={entry.name}
            stripe={index}
            tone={TONES[label]}
            title={
              <span className="font-mono text-xs">
                {entry.tunnel.sourcePort} {"->"} {destination}
              </span>
            }
            meta={[
              showHost ? entry.host.name : "",
              mode,
              t(STATUS_TEXT_KEYS[label]),
            ]
              .filter(Boolean)
              .join(" | ")}
            actions={
              running ? (
                <ListRowAction
                  label={t("tunnels.stop")}
                  tone="destructive"
                  disabled={acting === entry.name}
                  onClick={() => void toggle(entry, true)}
                >
                  <Square />
                </ListRowAction>
              ) : (
                <ListRowAction
                  label={t("tunnels.start")}
                  tone="brand"
                  disabled={acting === entry.name}
                  onClick={() => void toggle(entry, false)}
                >
                  <Play />
                </ListRowAction>
              )
            }
          />
        );
      })}
    </PanelList>
  );
}
