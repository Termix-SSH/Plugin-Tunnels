import { useEffect, useState } from "react";
import {
  AlertCircle,
  Clock,
  ExternalLink,
  Network,
  Play,
  RefreshCw,
  Settings,
  Square,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  logActivity,
  useHost,
  useHosts,
  useToast,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Card,
  EmptyState,
  GroupHeading,
  PanelSearch,
  PanelShell,
  Segmented,
} from "@termix-ssh/plugin-sdk/ui";
import type { TunnelConnection, TunnelStatus } from "../shared/types";
import { serverTunnelName, tunnelHostLabel } from "../shared/tunnel-naming";
import {
  cancelTunnel,
  connectTunnel,
  disconnectTunnel,
  subscribeTunnelStatuses,
  type TunnelStatusMap,
} from "./api";
import {
  connectRequestFor,
  hostTunnelSettings,
  tunnelMode,
} from "./host-tunnels";

type StatusLabel =
  "CONNECTED" | "CONNECTING" | "ERROR" | "WAITING" | "DISCONNECTED";

function statusLabel(status: TunnelStatus | undefined): StatusLabel {
  const value = status?.status?.toUpperCase();
  if (value === "CONNECTED") return "CONNECTED";
  if (value === "CONNECTING" || value === "VERIFYING") return "CONNECTING";
  if (value === "FAILED") return "ERROR";
  if (value === "RETRYING" || value === "WAITING") return "WAITING";
  return "DISCONNECTED";
}

const STATUS_TEXT_KEYS: Record<StatusLabel, string> = {
  CONNECTED: "tunnels.connected",
  CONNECTING: "tunnels.connecting",
  ERROR: "tunnels.error",
  WAITING: "tunnels.waiting",
  DISCONNECTED: "tunnels.disconnected",
};

function TunnelCard({
  host,
  tunnel,
  status,
  isActing,
  onAction,
}: {
  host: PluginHostRecord;
  tunnel: TunnelConnection;
  status: TunnelStatus | undefined;
  isActing: boolean;
  onAction: (action: "connect" | "disconnect" | "cancel") => void;
}) {
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);
  const label = statusLabel(status);
  const isConnected = label === "CONNECTED";
  const isConnecting = label === "CONNECTING";
  const isError = label === "ERROR";
  const isWaiting = label === "WAITING";

  let statusColor = "text-muted-foreground border-border bg-muted/30";
  if (isConnected)
    statusColor = "text-accent-brand border-accent-brand/40 bg-accent-brand/10";
  if (isConnecting)
    statusColor = "text-blue-400 border-blue-400/40 bg-blue-400/10";
  if (isError)
    statusColor = "text-destructive border-destructive/40 bg-destructive/10";
  if (isWaiting) statusColor = "text-warning border-warning/40 bg-warning/10";

  const mode = tunnelMode(tunnel);
  const destination =
    mode === "dynamic"
      ? t("tunnels.socksProxy")
      : `${tunnel.endpointHost ?? ""}:${tunnel.endpointPort}`;

  return (
    <Card className="flex flex-col overflow-hidden p-0 gap-0">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/10">
        <div className="flex items-center gap-2">
          <Network className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {t("tunnels.port")} {tunnel.sourcePort}
          </span>
        </div>
        <div
          className={`flex items-center gap-1.5 px-2 py-0.5 border text-[10px] font-bold uppercase ${statusColor}`}
        >
          {isConnecting || isActing ? (
            <RefreshCw className="size-3 animate-spin" />
          ) : isConnected ? (
            <Wifi className="size-3" />
          ) : isError ? (
            <AlertCircle className="size-3" />
          ) : isWaiting ? (
            <Clock className="size-3" />
          ) : (
            <WifiOff className="size-3" />
          )}
          {isActing ? t("tunnels.working") : t(STATUS_TEXT_KEYS[label])}
        </div>
      </div>
      <div className="px-4 py-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
            {t("tunnels.destination")}
          </span>
          <span
            className="text-sm font-mono font-semibold truncate"
            title={destination}
          >
            {destination}
          </span>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[10px] font-semibold px-1.5 py-px border border-border text-muted-foreground uppercase">
              {mode}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {t("tunnels.listensOn", { port: tunnel.sourcePort })}
            </span>
          </div>
        </div>

        {isError && status?.reason && (
          <div className="flex items-start gap-2 p-2 bg-destructive/5 border border-destructive/20 text-destructive text-[10px]">
            <AlertCircle className="size-3 mt-0.5 shrink-0" />
            <span>{status.reason}</span>
          </div>
        )}

        {showSettings && (
          <div className="border border-border bg-muted/20 p-3 flex flex-col gap-2 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground font-semibold">
                {t("tunnels.host")}
              </span>
              <span className="font-mono">{tunnelHostLabel(host)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground font-semibold">
                {t("tunnels.mode")}
              </span>
              <span className="uppercase font-bold">{mode}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground font-semibold">
                {t("tunnels.localPort")}
              </span>
              <span className="font-mono">{tunnel.sourcePort}</span>
            </div>
            {mode !== "dynamic" && (
              <>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground font-semibold">
                    {t("tunnels.remoteHost")}
                  </span>
                  <span className="font-mono">{tunnel.endpointHost}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground font-semibold">
                    {t("tunnels.remotePort")}
                  </span>
                  <span className="font-mono">{tunnel.endpointPort}</span>
                </div>
              </>
            )}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground font-semibold">
                {t("tunnels.maxRetries")}
              </span>
              <span className="font-mono">{tunnel.maxRetries}</span>
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-1">
          {isConnected ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-8 text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive gap-1.5"
              disabled={isActing}
              onClick={() => onAction("disconnect")}
            >
              <Square className="size-3" />
              {t("tunnels.stop")}
            </Button>
          ) : isConnecting || isWaiting ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-8 text-warning border-warning/40 hover:bg-warning/10 hover:text-warning gap-1.5"
              disabled={isActing}
              onClick={() => onAction("cancel")}
            >
              <Square className="size-3" />
              {t("tunnels.cancel")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-8 text-accent-brand border-accent-brand/40 hover:bg-accent-brand/10 hover:text-accent-brand gap-1.5"
              disabled={isActing}
              onClick={() => onAction("connect")}
            >
              {isActing ? (
                <RefreshCw className="size-3 animate-spin" />
              ) : (
                <Play className="size-3" />
              )}
              {t("tunnels.start")}
            </Button>
          )}
          <Button
            variant={showSettings ? "secondary" : "ghost"}
            size="icon"
            className={`h-8 w-8 ${showSettings ? "bg-accent-brand/10 text-accent-brand" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setShowSettings((s) => !s)}
          >
            <Settings className="size-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** A host's saved server tunnels, with live status and start/stop controls. */
interface TunnelEntry {
  host: PluginHostRecord;
  tunnel: TunnelConnection;
  index: number;
  name: string;
}

function tunnelEntries(host: PluginHostRecord): TunnelEntry[] {
  return hostTunnelSettings(host).connections.map((tunnel, index) => ({
    host,
    tunnel,
    index,
    name: serverTunnelName(host, index, tunnel),
  }));
}

/**
 * One host's tunnels, or with no host (the dashboard's counter) every host
 * that has tunnels, grouped by host.
 */
export function TunnelTab({ host: given }: { host?: PluginHostRecord }) {
  const { t } = useTranslation();
  const toast = useToast();
  const live = useHost(given?.id);
  const host = live ?? given ?? null;
  const { hosts } = useHosts();
  const [statuses, setStatuses] = useState<TunnelStatusMap>({});
  const [acting, setActing] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<
    "all" | "connected" | "stopped"
  >("all");

  useEffect(() => subscribeTunnelStatuses(setStatuses), []);

  // One recent-activity entry per host opened here.
  const hostId = host?.id;
  const hostLabel = host ? tunnelHostLabel(host) : "";
  useEffect(() => {
    if (typeof hostId !== "number") return;
    logActivity("tunnel", hostId, hostLabel).catch(() => {});
  }, [hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries: TunnelEntry[] = host
    ? tunnelEntries(host)
    : hosts.filter((h) => hostTunnelSettings(h).enabled).flatMap(tunnelEntries);
  const connectedCount = entries.filter(
    (entry) => statuses[entry.name]?.status === "connected",
  ).length;

  const handleAction = async (
    action: "connect" | "disconnect" | "cancel",
    entry: TunnelEntry,
  ) => {
    const { name } = entry;
    setActing((current) => ({ ...current, [name]: true }));
    try {
      if (action === "connect") {
        await connectTunnel(
          connectRequestFor(entry.host, entry.index, entry.tunnel),
        );
        toast.success(t("tunnels.clientTunnelStarted"));
      } else if (action === "disconnect") {
        await disconnectTunnel(name);
        toast.info(t("tunnels.clientTunnelStopped"));
      } else {
        await cancelTunnel(name);
        toast.info(t("tunnels.canceling"));
      }
    } catch {
      toast.error(t("tunnels.manualControlError"));
    } finally {
      setActing((current) => ({ ...current, [name]: false }));
    }
  };

  const q = query.trim().toLowerCase();
  const visible = entries
    .filter(
      ({ tunnel, name, host: owner }) =>
        !q ||
        name.toLowerCase().includes(q) ||
        owner.name.toLowerCase().includes(q) ||
        String(tunnel.sourcePort).includes(q) ||
        String(tunnel.endpointPort).includes(q) ||
        (tunnel.endpointHost ?? "").toLowerCase().includes(q),
    )
    .filter(({ name }) => {
      if (stateFilter === "all") return true;
      const connected = statuses[name]?.status === "connected";
      return stateFilter === "connected" ? connected : !connected;
    });

  const groups = new Map<string, TunnelEntry[]>();
  for (const entry of visible) {
    const list = groups.get(String(entry.host.id)) ?? [];
    list.push(entry);
    groups.set(String(entry.host.id), list);
  }

  const card = (entry: TunnelEntry) => (
    <TunnelCard
      key={entry.name}
      host={entry.host}
      tunnel={entry.tunnel}
      status={statuses[entry.name]}
      isActing={acting[entry.name] ?? false}
      onAction={(action) => handleAction(action, entry)}
    />
  );

  return (
    <PanelShell
      icon={<Network className="size-4" />}
      title={host ? host.name : t("tunnels.activeTunnels")}
      status={t("tunnels.activeCount", {
        connected: connectedCount,
        total: entries.length,
      })}
      actions={
        <a
          href="https://docs.termix.site/features/networking/tunnels"
          target="_blank"
          rel="noreferrer"
          className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          title={t("hosts.docsLink")}
        >
          <ExternalLink className="size-4" />
        </a>
      }
      toolbar={
        entries.length > 0 ? (
          <>
            <PanelSearch
              value={query}
              onChange={setQuery}
              placeholder={t("tunnels.search")}
            />
            <Segmented<"all" | "connected" | "stopped">
              value={stateFilter}
              onChange={setStateFilter}
              options={[
                { value: "all", label: t("tunnels.filterAll") },
                { value: "connected", label: t("tunnels.connected") },
                { value: "stopped", label: t("tunnels.filterStopped") },
              ]}
            />
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
              {t("tunnels.shownCount", {
                shown: visible.length,
                total: entries.length,
              })}
            </span>
          </>
        ) : undefined
      }
      className="p-2.5 gap-2"
    >
      {entries.length === 0 ? (
        <EmptyState
          icon={Network}
          title={t("tunnels.noSshTunnels")}
          hint={t("tunnels.createFirstTunnelMessage")}
          className="flex-1"
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={Network} title={t("tunnels.noMatches")} />
      ) : host ? (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
          {visible.map(card)}
        </div>
      ) : (
        [...groups.values()].map((group) => (
          <div key={group[0].host.id} className="flex flex-col gap-2">
            <GroupHeading
              title={group[0].host.name}
              count={group.length}
              className="pt-1"
            />
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
              {group.map(card)}
            </div>
          </div>
        ))
      )}
    </PanelShell>
  );
}
