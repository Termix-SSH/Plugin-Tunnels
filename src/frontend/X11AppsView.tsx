import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppWindow, Play, Square } from "lucide-react";
import { toast } from "sonner";
import {
  useHosts,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  GroupHeading,
  Input,
  ListBadge,
  ListRow,
  ListRowAction,
  LoadingState,
  PanelShell,
  Select2,
} from "@termix-ssh/plugin-sdk/ui";
import {
  apiErrorMessage,
  listX11Apps,
  startX11App,
  stopX11App,
  type X11App,
} from "./api";

const POLL_MS = 5000;

/** Run graphical programs on a host and show their windows here. */
export function X11AppsView({
  host,
  switcher,
}: {
  host?: PluginHostRecord | null;
  switcher?: ReactNode;
}) {
  const { t } = useTranslation();
  const { hosts } = useHosts();
  const sshHosts = hosts.filter(
    (h) => (h as { enableSsh?: boolean }).enableSsh !== false,
  );
  const [hostId, setHostId] = useState<number | "">(
    host?.id ? Number(host.id) : "",
  );
  const [command, setCommand] = useState("");
  const [data, setData] = useState<{
    configured: boolean;
    apps: X11App[];
  } | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await listX11Apps());
    } catch (error) {
      setData({ configured: true, apps: [] });
      toast.error(apiErrorMessage(error, t("x11.loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const start = async () => {
    if (!hostId || !command.trim()) return;
    setStarting(true);
    try {
      await startX11App(hostId, command.trim());
      setCommand("");
      void load();
    } catch (error) {
      toast.error(apiErrorMessage(error, t("x11.startFailed")));
    } finally {
      setStarting(false);
    }
  };

  const stop = async (app: X11App) => {
    try {
      await stopX11App(app.id);
      void load();
    } catch (error) {
      toast.error(apiErrorMessage(error, t("x11.stopFailed")));
    }
  };

  return (
    <PanelShell
      icon={<AppWindow className="size-4" />}
      title={t("x11.title")}
      tabs={switcher}
    >
      {!data ? (
        <LoadingState label={t("x11.loading")} />
      ) : !data.configured ? (
        <EmptyState
          icon={AppWindow}
          title={t("x11.notConfigured")}
          hint={t("x11.notConfiguredHint")}
          className="flex-1"
        />
      ) : (
        <>
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
            onKeyDown={(e) => {
              if (e.key === "Enter") void start();
            }}
          >
            <Select2
              value={hostId === "" ? "" : String(hostId)}
              onChange={(e) =>
                setHostId(e.target.value ? Number(e.target.value) : "")
              }
              aria-label={t("x11.host")}
              className="h-8 w-48 text-xs"
            >
              <option value="">{t("x11.pickHost")}</option>
              {sshHosts.map((h) => (
                <option key={h.id} value={String(h.id)}>
                  {h.name}
                </option>
              ))}
            </Select2>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t("x11.commandPlaceholder")}
              className="h-8 min-w-48 flex-1 font-mono text-xs"
              spellCheck={false}
            />
            <Button
              size="sm"
              onClick={() => void start()}
              disabled={starting || !hostId || !command.trim()}
            >
              <Play className="size-3.5" />
              {t("x11.start")}
            </Button>
          </div>
          <p className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
            {t("x11.hint")}
          </p>
          {data.apps.length === 0 ? (
            <EmptyState
              icon={AppWindow}
              title={t("x11.empty")}
              className="flex-1"
            />
          ) : (
            <>
              <GroupHeading
                title={t("x11.programs")}
                count={data.apps.length}
                className="px-3 pb-1.5 pt-3"
              />
              {data.apps.map((app) => (
                <ListRow
                  key={app.id}
                  icon={<AppWindow className="size-4" />}
                  title={app.command}
                  badges={
                    <ListBadge
                      tone={
                        app.running
                          ? "success"
                          : app.exitCode === 0
                            ? "muted"
                            : "destructive"
                      }
                    >
                      {app.running
                        ? t("x11.running")
                        : t("x11.exited", { code: app.exitCode ?? "?" })}
                    </ListBadge>
                  }
                  meta={
                    !app.running && app.output.trim()
                      ? `${app.hostName} | ${app.output.trim().split("\n").pop()}`
                      : app.hostName
                  }
                  actions={
                    <ListRowAction
                      label={app.running ? t("x11.stop") : t("x11.remove")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void stop(app);
                      }}
                    >
                      <Square />
                    </ListRowAction>
                  }
                />
              ))}
            </>
          )}
        </>
      )}
    </PanelShell>
  );
}
