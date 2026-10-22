import { ExternalLink } from "lucide-react";
import {
  useHosts,
  useSettings,
  useTabs,
  useTranslation,
  type CompanionDefaults,
  type CompanionProps,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import { hostTunnelsEnabled } from "./host-tunnels";
import { TunnelList } from "./TunnelList";

/** Starting state of the panel, from the user's settings. */
export function useTunnelsCompanionDefaults(): CompanionDefaults {
  const { values } = useSettings("user");
  const side = values.companionSide;
  return {
    open: values.companionAutoOpen === true,
    side: side === "left" || side === "bottom" ? side : "right",
    size: typeof values.companionSize === "number" ? values.companionSize : 320,
    edgeButton: values.companionEdgeButton !== false,
  };
}

/** This host's tunnels beside its terminal. */
export function TunnelsCompanion({ host, isVisible }: CompanionProps) {
  const { t } = useTranslation();
  const tabs = useTabs();
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-1.5">
      <div className="flex items-center gap-1">
        <span className="flex-1 truncate px-1 text-xs text-muted-foreground">
          {t("tunnels.sshTunnels")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => host && tabs.openTab(host, "tunnel")}
          title={t("companion.openTab")}
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>
      <TunnelList
        hosts={host ? [host] : []}
        showHost={false}
        isVisible={isVisible}
        empty={
          <p className="p-2 text-xs text-muted-foreground">
            {t("tunnels.noSshTunnels")}
          </p>
        }
      />
    </div>
  );
}

/** Dashboard card: every tunnel the user can reach, with start and stop. */
export function TunnelsCard({ isVisible, shell }: DashboardCardProps) {
  const { t } = useTranslation();
  const { hosts } = useHosts();
  return (
    <TunnelList
      hosts={hosts.filter(
        (host) => host.enableSsh !== false && hostTunnelsEnabled(host),
      )}
      showHost
      isVisible={isVisible}
      empty={
        <button
          type="button"
          onClick={() => shell.openSingletonTab("tunnel")}
          className="p-3 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {t("tunnels.noSshTunnels")}
        </button>
      }
    />
  );
}
