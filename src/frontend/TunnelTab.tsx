import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Clock,
  ExternalLink,
  Network,
  Pencil,
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
  usePluginPanelView,
  useToast,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  AddButton,
  Card,
  DataView,
  EmptyState,
  GroupHeading,
  PanelSearch,
  PanelShell,
  Segmented,
  InlineView,
  ListRow,
  ViewToggle,
  type DataColumn,
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
  hostTunnelsEnabled,
  tunnelMode,
} from "./host-tunnels";
import { useSavedTunnels } from "./saved-tunnels";
import { TunnelEditorView } from "./TunnelEditorView";
import { docsUrl } from "./docs";

// The orange add button with a light orange fill, used for every add action.
export const ADD_CLASS = "bg-accent-brand/10 dark:bg-accent-brand/10";

export type StatusLabel =
  "CONNECTED" | "CONNECTING" | "ERROR" | "WAITING" | "DISCONNECTED";

export function statusLabel(status: TunnelStatus | undefined): StatusLabel {
  const value = status?.status?.toUpperCase();
  if (value === "CONNECTED") return "CONNECTED";
  if (value === "CONNECTING" || value === "VERIFYING") return "CONNECTING";
  if (value === "FAILED") return "ERROR";
  if (value === "RETRYING" || value === "WAITING") return "WAITING";
  return "DISCONNECTED";
}

export const STATUS_TEXT_KEYS: Record<StatusLabel, string> = {
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
  onEdit,
}: {
  host: PluginHostRecord;
  tunnel: TunnelConnection;
  status: TunnelStatus | undefined;
  isActing: boolean;
  onAction: (action: "connect" | "disconnect" | "cancel") => void;
  onEdit: () => void;
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
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title={t("tunnels.edit")}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
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
export interface TunnelEntry {
  host: PluginHostRecord;
  tunnel: TunnelConnection;
  index: number;
  name: string;
}

export function tunnelEntries(
  host: PluginHostRecord,
  saved: Map<number, TunnelConnection[]>,
): TunnelEntry[] {
  return (saved.get(Number(host.id)) ?? []).map((tunnel, index) => ({
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
export function TunnelTab({
  host: given,
  switcher,
}: {
  host?: PluginHostRecord;
  /** The SSH tunnels | Gateways switch, shown first in the toolbar. */
  switcher?: ReactNode;
}) {
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

  const saved = useSavedTunnels();
  const [editing, setEditing] = useState<{
    host: PluginHostRecord;
    index: number | null;
  } | null>(null);
  const { view, density, columns, setView, setDensity, setColumns } =
    usePluginPanelView();
  const [picking, setPicking] = useState(false);

  const entries: TunnelEntry[] = host
    ? tunnelEntries(host, saved.byHost)
    : hosts
        .filter(hostTunnelsEnabled)
        .flatMap((h) => tunnelEntries(h, saved.byHost));
  const sshHosts = hosts.filter(
    (h) => h.enableSsh !== false && hostTunnelsEnabled(h),
  );
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
        toast.success(t("tunnels.tunnelStarted"));
      } else if (action === "disconnect") {
        await disconnectTunnel(name);
        toast.info(t("tunnels.tunnelStopped"));
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

  const listColumns: DataColumn<TunnelEntry>[] = [
    {
      key: "port",
      header: t("tunnels.listPort"),
      width: "minmax(0,1fr)",
      cell: (entry) => (
        <span className="truncate font-mono font-semibold">
          {entry.tunnel.sourcePort}
        </span>
      ),
    },
    ...(host
      ? []
      : [
          {
            key: "host",
            header: t("tunnels.listHost"),
            width: "minmax(0,1.2fr)",
            hideBelow: "md" as const,
            cell: (entry: TunnelEntry) => (
              <span className="truncate">{entry.host.name}</span>
            ),
          },
        ]),
    {
      key: "mode",
      header: t("tunnels.listMode"),
      width: "80px",
      hideBelow: "md",
      cell: (entry) => (
        <span className="uppercase text-muted-foreground">
          {tunnelMode(entry.tunnel)}
        </span>
      ),
    },
    {
      key: "destination",
      header: t("tunnels.listDestination"),
      width: "minmax(0,2fr)",
      cell: (entry) => (
        <span className="truncate font-mono text-muted-foreground">
          {tunnelMode(entry.tunnel) === "dynamic"
            ? t("tunnels.socksProxy")
            : `${entry.tunnel.endpointHost ?? ""}:${entry.tunnel.endpointPort}`}
        </span>
      ),
    },
    {
      key: "status",
      header: t("tunnels.listStatus"),
      width: "110px",
      cell: (entry) => {
        const label = statusLabel(statuses[entry.name]);
        const tone =
          label === "CONNECTED"
            ? "text-accent-brand"
            : label === "ERROR"
              ? "text-destructive"
              : label === "DISCONNECTED"
                ? "text-muted-foreground"
                : "text-warning";
        return (
          <span className={`truncate font-semibold ${tone}`}>
            {t(STATUS_TEXT_KEYS[label])}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: "",
      width: "76px",
      align: "end",
      cell: (entry) => {
        const label = statusLabel(statuses[entry.name]);
        const running = label === "CONNECTED";
        const waiting = label === "CONNECTING" || label === "WAITING";
        return (
          <span
            className="flex items-center justify-end gap-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={acting[entry.name]}
              title={
                running
                  ? t("tunnels.stop")
                  : waiting
                    ? t("tunnels.cancel")
                    : t("tunnels.start")
              }
              onClick={() =>
                void handleAction(
                  running ? "disconnect" : waiting ? "cancel" : "connect",
                  entry,
                )
              }
            >
              {running || waiting ? (
                <Square className="size-3" />
              ) : (
                <Play className="size-3" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("tunnels.edit")}
              onClick={() =>
                setEditing({ host: entry.host, index: entry.index })
              }
            >
              <Pencil className="size-3" />
            </Button>
          </span>
        );
      },
    },
  ];

  const card = (entry: TunnelEntry) => (
    <TunnelCard
      key={entry.name}
      host={entry.host}
      tunnel={entry.tunnel}
      status={statuses[entry.name]}
      isActing={acting[entry.name] ?? false}
      onAction={(action) => handleAction(action, entry)}
      onEdit={() => setEditing({ host: entry.host, index: entry.index })}
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
        <>
          <AddButton
            label={t("tunnels.addTunnel")}
            className={ADD_CLASS}
            onClick={() => {
              if (host) setEditing({ host, index: null });
              else if (sshHosts.length === 1)
                setEditing({ host: sshHosts[0], index: null });
              else setPicking(true);
            }}
            disabled={sshHosts.length === 0 && !host}
          />
          <a
            href={docsUrl()}
            target="_blank"
            rel="noreferrer"
            className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title={t("hosts.docsLink")}
          >
            <ExternalLink className="size-4" />
          </a>
        </>
      }
      toolbar={
        entries.length > 0 || switcher ? (
          <>
            {switcher}
            {entries.length > 0 && (
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
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {t("tunnels.shownCount", {
                      shown: visible.length,
                      total: entries.length,
                    })}
                  </span>
                  <ViewToggle
                    view={view}
                    onView={setView}
                    density={density}
                    onDensity={setDensity}
                    columns={columns}
                    onColumns={setColumns}
                  />
                </div>
              </>
            )}
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
      ) : view === "list" ? (
        <DataView
          items={visible}
          view="list"
          density={density}
          getKey={(entry) => entry.name}
          renderCard={card}
          columns={{ base: 1 }}
          listColumns={listColumns}
          empty={<EmptyState icon={Network} title={t("tunnels.noMatches")} />}
        />
      ) : host ? (
        <DataView
          items={visible}
          view="grid"
          getKey={(entry) => entry.name}
          renderCard={card}
          columns={{ base: 1, md: 2, lg: 3 }}
          size={columns}
          minCardWidth={300}
          listColumns={listColumns}
          empty={<EmptyState icon={Network} title={t("tunnels.noMatches")} />}
        />
      ) : (
        [...groups.values()].map((group) => (
          <div key={group[0].host.id} className="flex flex-col gap-2">
            <GroupHeading
              title={group[0].host.name}
              count={group.length}
              className="pt-1"
            />
            <DataView
              items={group}
              view="grid"
              getKey={(entry) => entry.name}
              renderCard={card}
              columns={{ base: 1, md: 2, lg: 3 }}
              size={columns}
              minCardWidth={300}
              listColumns={listColumns}
              empty={null}
            />
          </div>
        ))
      )}
      {picking && (
        <InlineView
          open
          onOpenChange={(open) => {
            if (!open) setPicking(false);
          }}
          title={t("tunnels.pickHost")}
          icon={<Network className="size-4" />}
        >
          <div className="flex flex-col gap-1 p-3">
            {sshHosts.map((h) => (
              <ListRow
                key={h.id}
                icon={<Network className="size-4" />}
                title={h.name || h.ip}
                meta={h.ip}
                onClick={() => {
                  setPicking(false);
                  setEditing({ host: h, index: null });
                }}
              />
            ))}
          </div>
        </InlineView>
      )}
      {editing && (
        <TunnelEditorView
          host={editing.host}
          all={saved.byHost.get(Number(editing.host.id)) ?? []}
          index={editing.index}
          onSave={(connections) =>
            saved.save(Number(editing.host.id), connections)
          }
          onClose={() => setEditing(null)}
        />
      )}
    </PanelShell>
  );
}
