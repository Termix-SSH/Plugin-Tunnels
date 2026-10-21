import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Globe, RefreshCw, Router, Trash2 } from "lucide-react";
import {
  useHosts,
  useToast,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  BackButton,
  Button,
  EmptyState,
  FakeSwitch,
  FormFooter,
  GroupHeading,
  InlineView,
  Input,
  ListRow,
  PanelShell,
  SectionCard,
  SettingRow,
  Select2,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import type { Gateway, GatewayPreflight } from "../shared/types";
import {
  applyGateway,
  apiErrorMessage,
  checkGateway,
  createGateway,
  deleteGateway,
  installGatewayPackages,
  listGateways,
  preflightHost,
  scanGateway,
  updateGateway,
} from "./api";
import {
  STATE_KEYS,
  TONE_CLASS,
  firewallPorts,
  parsePortList,
  stateTone,
} from "./gateway-utils";
import { GatewayPorts } from "./GatewayPorts";

function hostName(hosts: PluginHostRecord[], id: number): string {
  const host = hosts.find((candidate) => Number(candidate.id) === id);
  return host ? host.name || host.ip : `#${id}`;
}

function StatePill({ gateway }: { gateway: Gateway }) {
  const { t } = useTranslation();
  const state = gateway.status.state;
  return (
    <span
      className={`px-2 py-0.5 border text-[10px] font-bold uppercase ${TONE_CLASS[stateTone(state)]}`}
    >
      {t(STATE_KEYS[state])}
    </span>
  );
}

type Side = "private" | "public";

/** Checks one host and offers to install what is missing. */
function HostCheck({
  hostId,
  side,
  onReady,
}: {
  hostId: number | null;
  side: Side;
  onReady: (ready: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [result, setResult] = useState<GatewayPreflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (hostId === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await preflightHost(hostId);
      setResult(next);
      onReady(next.root && next.wireguard && next.nftables && next.systemd);
    } catch (e) {
      setResult(null);
      onReady(false);
      setError(apiErrorMessage(e, t("gateways.checkFailed")));
    } finally {
      setBusy(false);
    }
  }, [hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setResult(null);
    onReady(false);
    if (hostId !== null) void run();
  }, [hostId, run]); // eslint-disable-line react-hooks/exhaustive-deps

  const install = async () => {
    if (hostId === null) return;
    setBusy(true);
    try {
      await installGatewayPackages(hostId);
      await run();
    } catch (e) {
      toast.error(apiErrorMessage(e, t("gateways.installFailed")));
      setBusy(false);
    }
  };

  if (hostId === null) return null;

  const line = (ok: boolean, label: string) => (
    <li className={ok ? "text-accent-brand" : "text-destructive"}>
      {ok ? "+" : "-"} {label}
    </li>
  );

  return (
    <div className="border border-border bg-muted/20 p-3 text-xs">
      <div className="mb-1 font-bold text-muted-foreground">
        {side === "private"
          ? t("gateways.privateHostCheck")
          : t("gateways.publicHostCheck")}
      </div>
      {busy && (
        <p className="text-muted-foreground">{t("gateways.checking")}</p>
      )}
      {error && <p className="text-destructive">{error}</p>}
      {result && !busy && (
        <>
          <ul className="space-y-0.5">
            {line(result.root, t("gateways.needRoot"))}
            {line(result.systemd, "systemd")}
            {line(result.wireguard, "WireGuard")}
            {line(result.nftables, "nftables")}
          </ul>
          {result.root && (!result.wireguard || !result.nftables) && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-[11px]"
              onClick={() => void install()}
            >
              {t("gateways.installMissing")}
            </Button>
          )}
          {!result.root && (
            <p className="mt-2 text-muted-foreground">
              {t("gateways.sudoHint")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function CreateGateway({
  onDone,
  onCreated,
}: {
  onDone: () => void;
  onCreated: (gateway: Gateway | null) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { hosts } = useHosts();
  const sshHosts = hosts.filter((host) => host.enableSsh !== false);
  const [name, setName] = useState("");
  const [privateId, setPrivateId] = useState<number | null>(null);
  const [publicId, setPublicId] = useState<number | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [port, setPort] = useState("");
  const [privateReady, setPrivateReady] = useState(false);
  const [publicReady, setPublicReady] = useState(false);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (privateId === null || publicId === null) return;
    setSaving(true);
    try {
      const gateway = await createGateway({
        name: name.trim(),
        privateHostId: privateId,
        publicHostId: publicId,
        endpoint: endpoint.trim(),
        listenPort: port ? Number(port) : undefined,
      });
      toast.success(t("gateways.created"));
      onCreated(gateway);
    } catch (error) {
      toast.error(apiErrorMessage(error, t("gateways.createFailed")));
      // The gateway may exist already when only the first apply failed.
      onCreated(null);
    } finally {
      setSaving(false);
    }
  };

  const options = (exclude: number | null) =>
    sshHosts
      .filter((host) => Number(host.id) !== exclude)
      .map((host) => (
        <option key={host.id} value={host.id}>
          {host.name || host.ip}
        </option>
      ));

  const ready =
    name.trim() &&
    privateId !== null &&
    publicId !== null &&
    endpoint.trim() &&
    privateReady &&
    publicReady;

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
      title={t("gateways.newGateway")}
      icon={<Router className="size-4" />}
      footer={
        <FormFooter
          onCancel={onDone}
          onSave={() => void create()}
          saving={saving}
          dirty
          disabled={!ready}
          saveLabel={t("gateways.create")}
          cancelLabel={t("common.cancel")}
        />
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <p className="text-xs text-muted-foreground">{t("gateways.intro")}</p>
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.name")}
          <Input
            className="h-8 text-xs"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.privateHost")}
          <Select2
            value={privateId ?? ""}
            onChange={(e) => setPrivateId(Number(e.target.value) || null)}
            placeholder={t("common.selectHost")}
            className="h-8 text-xs border border-border bg-background px-2"
          >
            {options(publicId)}
          </Select2>
          <span className="font-normal">{t("gateways.privateHostHint")}</span>
        </label>
        <HostCheck
          hostId={privateId}
          side="private"
          onReady={setPrivateReady}
        />
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.publicHost")}
          <Select2
            value={publicId ?? ""}
            onChange={(e) => {
              const id = Number(e.target.value) || null;
              setPublicId(id);
              const picked = sshHosts.find((host) => Number(host.id) === id);
              if (picked && !endpoint) setEndpoint(picked.ip);
            }}
            placeholder={t("common.selectHost")}
            className="h-8 text-xs border border-border bg-background px-2"
          >
            {options(privateId)}
          </Select2>
          <span className="font-normal">{t("gateways.publicHostHint")}</span>
        </label>
        <HostCheck hostId={publicId} side="public" onReady={setPublicReady} />
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.endpoint")}
          <Input
            className="h-8 text-xs"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
          <span className="font-normal">{t("gateways.endpointHint")}</span>
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.tunnelPort")}
          <Input
            className="h-8 text-xs"
            inputMode="numeric"
            placeholder={t("gateways.tunnelPortAuto")}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </label>
      </div>
    </InlineView>
  );
}

function ScanSettings({
  gateway,
  hosts,
  onChanged,
}: {
  gateway: Gateway;
  hosts: PluginHostRecord[];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [ignored, setIgnored] = useState(gateway.ignoredPorts.join(", "));

  const patch = async (input: Parameters<typeof updateGateway>[1]) => {
    try {
      await updateGateway(gateway.id, input);
      onChanged();
    } catch (error) {
      toast.error(apiErrorMessage(error, t("gateways.saveFailed")));
    }
  };

  const scanNow = async () => {
    setScanning(true);
    try {
      const found = await scanGateway(gateway.id);
      toast.success(t("gateways.scanFound", { count: found }));
      onChanged();
    } catch (error) {
      toast.error(apiErrorMessage(error, t("gateways.scanFailed")));
    } finally {
      setScanning(false);
    }
  };

  const others = hosts.filter(
    (host) =>
      host.enableSsh !== false &&
      Number(host.id) !== gateway.privateHostId &&
      Number(host.id) !== gateway.publicHostId,
  );

  return (
    <SectionCard
      title={t("gateways.discovery")}
      icon={<RefreshCw className="size-3.5" />}
      action={
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[10px]"
          disabled={scanning}
          onClick={() => void scanNow()}
        >
          {scanning ? t("gateways.scanning") : t("gateways.scanNow")}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 py-3">
        <SettingRow
          label={t("gateways.scanLabel")}
          description={t("gateways.scanDesc")}
        >
          <FakeSwitch
            checked={gateway.scanEnabled}
            onChange={(value) => void patch({ scanEnabled: value })}
          />
        </SettingRow>
        <SettingRow
          label={t("gateways.autoEnableLabel")}
          description={t("gateways.autoEnableDesc")}
        >
          <FakeSwitch
            checked={gateway.autoEnable}
            onChange={(value) => void patch({ autoEnable: value })}
          />
        </SettingRow>
        <SettingRow
          label={t("gateways.scanGuestsLabel")}
          description={t("gateways.scanGuestsDesc")}
        >
          <FakeSwitch
            checked={gateway.scanGuests}
            onChange={(value) => void patch({ scanGuests: value })}
          />
        </SettingRow>
        <SettingRow
          label={t("gateways.scanEvery")}
          description={t("gateways.scanEveryDesc")}
        >
          <Input
            className="h-7 w-20 text-xs"
            inputMode="numeric"
            defaultValue={gateway.scanInterval}
            onBlur={(e) => {
              const minutes = Number(e.target.value);
              if (minutes >= 1 && minutes !== gateway.scanInterval) {
                void patch({ scanInterval: minutes });
              }
            }}
          />
        </SettingRow>
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.ignoredPorts")}
          <Input
            className="h-8 text-xs"
            value={ignored}
            onChange={(e) => setIgnored(e.target.value)}
            onBlur={() => void patch({ ignoredPorts: parsePortList(ignored) })}
          />
        </label>
        {others.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-muted-foreground">
              {t("gateways.alsoScan")}
            </span>
            {others.map((host) => {
              const id = Number(host.id);
              const on = gateway.sourceHostIds.includes(id);
              return (
                <SettingRow key={host.id} label={host.name || host.ip}>
                  <FakeSwitch
                    checked={on}
                    onChange={(value) =>
                      void patch({
                        sourceHostIds: value
                          ? [...gateway.sourceHostIds, id]
                          : gateway.sourceHostIds.filter((h) => h !== id),
                      })
                    }
                  />
                </SettingRow>
              );
            })}
          </div>
        )}
        {gateway.status.lastScanAt && (
          <p className="text-[10px] text-muted-foreground">
            {t("gateways.lastScan", {
              time: new Date(gateway.status.lastScanAt).toLocaleTimeString(),
            })}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function GatewayDetail({
  initial,
  hosts,
  onBack,
}: {
  initial: Gateway;
  hosts: PluginHostRecord[];
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [gateway, setGateway] = useState<Gateway>(initial);
  const [busy, setBusy] = useState<"apply" | "check" | "delete" | null>(null);

  const reload = useCallback(async () => {
    try {
      const all = await listGateways();
      const next = all.find((candidate) => candidate.id === initial.id);
      if (next) setGateway(next);
      else onBack();
    } catch {
      // The next poll tries again.
    }
  }, [initial.id, onBack]);

  useEffect(() => {
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [reload]);

  const run = async (kind: "apply" | "check", job: () => Promise<Gateway>) => {
    setBusy(kind);
    try {
      setGateway(await job());
    } catch (error) {
      toast.error(apiErrorMessage(error, t("gateways.actionFailed")));
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t("gateways.deleteTitle"),
      description: t("gateways.deleteHint"),
      confirmLabel: t("common.delete"),
      destructive: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await deleteGateway(gateway.id);
      onBack();
    } catch (error) {
      toast.error(apiErrorMessage(error, t("gateways.actionFailed")));
      setBusy(null);
    }
  };

  const age = gateway.status.handshakeAge;
  const firewall = firewallPorts(gateway);

  return (
    <PanelShell
      icon={<Router className="size-4" />}
      title={gateway.name}
      status={<StatePill gateway={gateway} />}
      leading={<BackButton onClick={onBack} />}
      actions={
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy !== null}
            onClick={() => void run("check", () => checkGateway(gateway.id))}
          >
            {t("gateways.checkNow")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy !== null}
            onClick={() => void run("apply", () => applyGateway(gateway.id))}
          >
            {busy === "apply" ? t("gateways.applying") : t("gateways.apply")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive"
            disabled={busy !== null}
            title={t("common.delete")}
            onClick={() => void remove()}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      }
      className="gap-3 p-2.5"
    >
      <div className="border border-border bg-muted/20 p-3 text-xs">
        <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
          <span>
            <span className="text-muted-foreground">
              {t("gateways.privateHost")}:{" "}
            </span>
            {hostName(hosts, gateway.privateHostId)}
          </span>
          <span>
            <span className="text-muted-foreground">
              {t("gateways.publicHost")}:{" "}
            </span>
            {hostName(hosts, gateway.publicHostId)} ({gateway.endpoint})
          </span>
          <span>
            <span className="text-muted-foreground">
              {t("gateways.tunnelPort")}:{" "}
            </span>
            UDP {gateway.listenPort}
          </span>
          <span>
            <span className="text-muted-foreground">
              {t("gateways.handshake")}:{" "}
            </span>
            {age === null
              ? t("gateways.never")
              : t("gateways.secondsAgo", { count: age })}
          </span>
        </div>
        {gateway.status.message && (
          <p className="mt-2 text-warning">{gateway.status.message}</p>
        )}
      </div>

      <GatewayPorts gateway={gateway} onChanged={() => void reload()} />

      <ScanSettings
        gateway={gateway}
        hosts={hosts}
        onChanged={() => void reload()}
      />

      <SectionCard
        title={t("gateways.firewallTitle")}
        icon={<Globe className="size-3.5" />}
      >
        <div className="py-3 text-xs">
          <p className="mb-2 text-muted-foreground">
            {t("gateways.firewallHint")}
          </p>
          <p className="font-mono">{firewall.join(", ")}</p>
        </div>
      </SectionCard>
    </PanelShell>
  );
}

/** Gateways: a private host published through a public one over WireGuard. */
export function GatewaysView({ switcher }: { switcher?: ReactNode }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { hosts } = useHosts();
  const [gateways, setGateways] = useState<Gateway[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try {
      setGateways(await listGateways());
    } catch (error) {
      toast.error(apiErrorMessage(error, t("gateways.loadFailed")));
      setGateways((current) => current ?? []);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 10_000);
    return () => clearInterval(timer);
  }, [reload]);

  const current = gateways?.find((gateway) => gateway.id === selected) ?? null;
  if (current) {
    return (
      <GatewayDetail
        key={current.id}
        initial={current}
        hosts={hosts}
        onBack={() => {
          setSelected(null);
          void reload();
        }}
      />
    );
  }

  return (
    <PanelShell
      icon={<Router className="size-4" />}
      title={t("gateways.title")}
      status={t("gateways.count", { count: gateways?.length ?? 0 })}
      actions={
        <AddButton
          label={t("gateways.newGateway")}
          className="bg-accent-brand/10 dark:bg-accent-brand/10"
          onClick={() => setCreating(true)}
        />
      }
      toolbar={switcher}
      className="gap-2 p-2.5"
    >
      {gateways && gateways.length === 0 ? (
        <EmptyState
          icon={Router}
          title={t("gateways.empty")}
          hint={t("gateways.emptyHint")}
          className="flex-1"
        />
      ) : (
        <>
          <GroupHeading title={t("gateways.title")} count={gateways?.length} />
          {gateways?.map((gateway) => (
            <ListRow
              key={gateway.id}
              icon={<Router className="size-4" />}
              title={gateway.name}
              badges={<StatePill gateway={gateway} />}
              meta={`${hostName(hosts, gateway.privateHostId)} -> ${hostName(hosts, gateway.publicHostId)} | ${t("gateways.portCount", { count: gateway.ports.filter((p) => p.enabled).length })}`}
              onClick={() => setSelected(gateway.id)}
            />
          ))}
        </>
      )}
      {creating && (
        <CreateGateway
          onDone={() => setCreating(false)}
          onCreated={(gateway) => {
            setCreating(false);
            void reload();
            if (gateway) setSelected(gateway.id);
          }}
        />
      )}
    </PanelShell>
  );
}
