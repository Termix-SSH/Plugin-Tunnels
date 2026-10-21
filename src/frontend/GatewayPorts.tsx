import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useToast, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  Button,
  FakeSwitch,
  FormFooter,
  GroupHeading,
  InlineView,
  Input,
  ListRow,
  Select2,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import type { Gateway, GatewayPort, GatewayProto } from "../shared/types";
import {
  addGatewayPort,
  apiErrorMessage,
  deleteGatewayPort,
  updateGatewayPort,
} from "./api";
import { portTarget } from "./gateway-utils";

interface Draft {
  proto: GatewayProto;
  publicPort: string;
  targetHost: string;
  targetPort: string;
  label: string;
}

const emptyDraft: Draft = {
  proto: "tcp",
  publicPort: "",
  targetHost: "",
  targetPort: "",
  label: "",
};

function draftOf(port: GatewayPort): Draft {
  return {
    proto: port.proto,
    publicPort: String(port.publicPort),
    targetHost: port.targetHost,
    targetPort: String(port.targetPort),
    label: port.label,
  };
}

function PortForm({
  gateway,
  port,
  onDone,
}: {
  gateway: Gateway;
  port: GatewayPort | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft>(port ? draftOf(port) : emptyDraft);
  const [saving, setSaving] = useState(false);

  const set = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const save = async (force = false) => {
    setSaving(true);
    const input = {
      proto: draft.proto,
      publicPort: Number(draft.publicPort),
      targetHost: draft.targetHost.trim(),
      targetPort: Number(draft.targetPort || draft.publicPort),
      label: draft.label.trim(),
      force,
    };
    try {
      if (port) await updateGatewayPort(gateway.id, port.id, input);
      else await addGatewayPort(gateway.id, input);
      onDone();
    } catch (error) {
      const data = (error as { response?: { data?: { code?: string } } })
        ?.response?.data;
      const message = apiErrorMessage(error, t("gateways.portSaveFailed"));
      if (data?.code === "conflict") {
        const ok = await confirm({
          title: t("gateways.portBusyTitle"),
          description: `${message}. ${t("gateways.portBusyHint")}`,
          confirmLabel: t("gateways.useAnyway"),
          destructive: false,
        });
        if (ok) {
          await save(true);
          return;
        }
      } else {
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
      title={port ? t("gateways.editPort") : t("gateways.addPort")}
      footer={
        <FormFooter
          onCancel={onDone}
          onSave={() => void save()}
          saving={saving}
          dirty
          disabled={!draft.publicPort}
          saveLabel={t("common.save")}
          cancelLabel={t("common.cancel")}
        />
      }
    >
      <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.protocol")}
          <Select2
            value={draft.proto}
            onChange={(e) => set({ proto: e.target.value as GatewayProto })}
            className="h-8 text-xs border border-border bg-background px-2"
          >
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="both">{t("gateways.bothProtocols")}</option>
          </Select2>
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.publicPort")}
          <Input
            className="h-8 text-xs"
            inputMode="numeric"
            value={draft.publicPort}
            onChange={(e) => set({ publicPort: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.targetHost")}
          <Input
            className="h-8 text-xs"
            placeholder={t("gateways.targetHostPlaceholder")}
            value={draft.targetHost}
            onChange={(e) => set({ targetHost: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground">
          {t("gateways.targetPort")}
          <Input
            className="h-8 text-xs"
            inputMode="numeric"
            placeholder={draft.publicPort}
            value={draft.targetPort}
            onChange={(e) => set({ targetPort: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-bold text-muted-foreground md:col-span-2">
          {t("gateways.label")}
          <Input
            className="h-8 text-xs"
            value={draft.label}
            onChange={(e) => set({ label: e.target.value })}
          />
        </label>
      </div>
    </InlineView>
  );
}

function PortRowView({
  gateway,
  port,
  onEdit,
  onChanged,
}: {
  gateway: Gateway;
  port: GatewayPort;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const status = gateway.status.ports[port.id];

  const toggle = async (enabled: boolean, force = false) => {
    setBusy(true);
    try {
      await updateGatewayPort(gateway.id, port.id, { enabled, force });
      onChanged();
    } catch (error) {
      const data = (error as { response?: { data?: { code?: string } } })
        ?.response?.data;
      const message = apiErrorMessage(error, t("gateways.portSaveFailed"));
      if (
        data?.code === "conflict" &&
        (await confirm({
          title: t("gateways.portBusyTitle"),
          description: `${message}. ${t("gateways.portBusyHint")}`,
          confirmLabel: t("gateways.useAnyway"),
          destructive: false,
        }))
      ) {
        await toggle(enabled, true);
        return;
      }
      if (data?.code !== "conflict") toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t("gateways.removePortTitle"),
      description: t("gateways.removePortHint", { port: port.publicPort }),
      confirmLabel: t("common.delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteGatewayPort(gateway.id, port.id);
      onChanged();
    } catch (error) {
      toast.error(apiErrorMessage(error, t("gateways.portSaveFailed")));
    }
  };

  const badges = (
    <>
      <span className="border border-border px-1.5 py-px text-[10px] font-semibold uppercase text-muted-foreground">
        {port.proto === "both" ? "tcp+udp" : port.proto}
      </span>
      {port.source === "scan" && (
        <span className="border border-border px-1.5 py-px text-[10px] text-muted-foreground">
          {t("gateways.found")}
        </span>
      )}
      {port.enabled && status?.reachable === false && (
        <span className="border border-destructive/40 px-1.5 py-px text-[10px] text-destructive">
          {t("gateways.noAnswer")}
        </span>
      )}
      {port.source === "scan" && status?.listening === false && (
        <span className="border border-warning/40 px-1.5 py-px text-[10px] text-warning">
          {t("gateways.notListening")}
        </span>
      )}
    </>
  );

  return (
    <ListRow
      title={
        <span className="font-mono">
          {port.publicPort} {"->"} {portTarget(gateway, port)}
        </span>
      }
      badges={badges}
      meta={port.label || undefined}
      dimmed={!port.enabled}
      actions={
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("tunnels.edit")}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            title={t("common.delete")}
            onClick={() => void remove()}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      }
      trailing={
        <FakeSwitch
          checked={port.enabled}
          disabled={busy}
          onChange={(value) => void toggle(value)}
        />
      }
    />
  );
}

/** A gateway's forwarded ports, with a switch for each one. */
export function GatewayPorts({
  gateway,
  onChanged,
}: {
  gateway: Gateway;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<GatewayPort | "new" | null>(null);

  const manual = gateway.ports.filter((port) => port.source === "manual");
  const found = gateway.ports.filter((port) => port.source === "scan");

  const close = () => {
    setEditing(null);
    onChanged();
  };

  const rows = (list: GatewayPort[]) =>
    list.map((port) => (
      <PortRowView
        key={port.id}
        gateway={gateway}
        port={port}
        onEdit={() => setEditing(port)}
        onChanged={onChanged}
      />
    ));

  return (
    <div className="flex flex-col gap-2">
      <GroupHeading
        title={t("gateways.ports")}
        count={manual.length}
        action={
          <AddButton
            compact
            className="bg-accent-brand/10 dark:bg-accent-brand/10"
            label={t("gateways.addPort")}
            onClick={() => setEditing("new")}
          />
        }
      />
      {manual.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          {t("gateways.noPorts")}
        </p>
      ) : (
        rows(manual)
      )}
      {found.length > 0 && (
        <>
          <GroupHeading title={t("gateways.foundPorts")} count={found.length} />
          {rows(found)}
        </>
      )}
      {editing && (
        <PortForm
          gateway={gateway}
          port={editing === "new" ? null : editing}
          onDone={close}
        />
      )}
    </div>
  );
}
