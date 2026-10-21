import { useState } from "react";
import { Network } from "lucide-react";
import {
  useToast,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import { FormFooter, InlineView, useConfirm } from "@termix-ssh/plugin-sdk/ui";
import type { TunnelConnection } from "../shared/types";
import { newTunnel, TunnelForm } from "./TunnelForm";
import { apiErrorMessage } from "./api";

/**
 * Adds one tunnel to a host, or edits one of its tunnels. The host's other
 * tunnels are kept as they are.
 */
export function TunnelEditorView({
  host,
  all,
  index,
  onSave,
  onClose,
}: {
  host: PluginHostRecord;
  /** The host's saved list. */
  all: TunnelConnection[];
  /** Which tunnel to edit, or null to add a new one. */
  index: number | null;
  onSave: (connections: TunnelConnection[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const original = index === null ? null : (all[index] ?? null);
  const [draft, setDraft] = useState<TunnelConnection>(original ?? newTunnel());
  const [saving, setSaving] = useState(false);

  const dirty =
    original === null || JSON.stringify(draft) !== JSON.stringify(original);

  const run = async (next: TunnelConnection[]) => {
    setSaving(true);
    try {
      await onSave(next);
      toast.success(t("tunnels.saved"));
      onClose();
    } catch (error) {
      toast.error(apiErrorMessage(error, t("tunnels.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const save = () =>
    run(
      index === null || original === null
        ? [...all, draft]
        : all.map((tunnel, i) => (i === index ? draft : tunnel)),
    );

  const remove = async () => {
    const ok = await confirm({
      title: t("tunnels.deleteTitle"),
      description: t("tunnels.deleteHint"),
      confirmLabel: t("common.delete"),
      destructive: true,
    });
    if (ok) await run(all.filter((_, i) => i !== index));
  };

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        original === null
          ? t("tunnels.addTitle", { name: host.name || host.ip })
          : t("tunnels.editTitle", { name: host.name || host.ip })
      }
      icon={<Network className="size-4" />}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void save()}
          saving={saving}
          dirty={dirty}
          saveLabel={t("common.save")}
          cancelLabel={t("common.cancel")}
          onDelete={original === null ? undefined : () => void remove()}
          deleteLabel={t("common.delete")}
        />
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <p className="text-xs text-muted-foreground">
          {t("hosts.tunnelRequirementsText")}
        </p>
        <TunnelForm
          hostId={Number(host.id)}
          tunnel={draft}
          onChange={setDraft}
        />
      </div>
    </InlineView>
  );
}
