import { Network } from "lucide-react";
import {
  useTranslation,
  type HostEditorSectionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { FakeSwitch, SectionCard, SettingRow } from "@termix-ssh/plugin-sdk/ui";
import { docsUrl } from "./docs";

type PluginSettingsForm = Record<string, Record<string, unknown>>;

/**
 * The host editor's Tunnels tab: the on/off switch for this host. The
 * tunnels themselves are set up in the Tunnels tab. The switch follows the
 * host defaults like any other host setting.
 */
export function HostTunnelsSection({
  form,
  updateForm,
}: HostEditorSectionProps) {
  const { t } = useTranslation();
  const settings = ((form?.pluginSettings as PluginSettingsForm | undefined)
    ?.tunnels ?? {}) as Record<string, unknown>;

  const setEnabled = (value: boolean) =>
    updateForm((current) => {
      const all = (current.pluginSettings ?? {}) as PluginSettingsForm;
      return {
        ...current,
        pluginSettings: {
          ...all,
          tunnels: { ...(all.tunnels ?? {}), enableTunnel: value },
        },
      };
    });

  return (
    <SectionCard
      title={t("hosts.tunnelSettings")}
      icon={<Network className="size-3.5" />}
    >
      <div className="flex flex-col gap-4 py-3">
        <SettingRow
          label={t("hosts.enableTunneling")}
          description={
            <>
              {t("hosts.enableTunnelingDesc")}{" "}
              <a
                href={docsUrl()}
                target="_blank"
                rel="noreferrer"
                className="text-accent-brand hover:underline"
              >
                {t("hosts.docsLink")}
              </a>
            </>
          }
        >
          <FakeSwitch
            checked={settings.enableTunnel === true}
            onChange={setEnabled}
          />
        </SettingRow>
        <p className="text-xs text-muted-foreground">
          {t("hosts.tunnelsMoved")}
        </p>
      </div>
    </SectionCard>
  );
}
