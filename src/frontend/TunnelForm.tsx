import { Network } from "lucide-react";
import { useHosts, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  FakeSwitch,
  Input,
  SectionCard,
  SettingRow,
} from "@termix-ssh/plugin-sdk/ui";
import type { TunnelConnection } from "../shared/types";
import { tunnelMode } from "./host-tunnels";

export function newTunnel(): TunnelConnection {
  return {
    scope: "s2s",
    mode: "local",
    sourcePort: 8080,
    endpointHost: "",
    endpointPort: 80,
    bindHost: "127.0.0.1",
    maxRetries: 3,
    retryInterval: 10,
    autoStart: false,
  };
}

const MODE_DESCRIPTION_KEYS = {
  local: "hosts.tunnelModeLocalDesc",
  remote: "hosts.tunnelModeRemoteDesc",
  dynamic: "hosts.tunnelModeDynamicDesc",
} as const;

const numberInputClass =
  "h-7 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

/** The fields of one server tunnel. The caller keeps and saves the draft. */
export function TunnelForm({
  hostId,
  tunnel,
  onChange,
}: {
  hostId: number;
  tunnel: TunnelConnection;
  onChange: (next: TunnelConnection) => void;
}) {
  const { t } = useTranslation();
  const { hosts } = useHosts();
  const mode = tunnelMode(tunnel);
  const endpointInputId = `server-tunnel-endpoint-${hostId}`;
  const update = (patch: Partial<TunnelConnection>) =>
    onChange({ ...tunnel, ...patch });

  return (
    <SectionCard
      title={t("hosts.serverTunnelsSection")}
      icon={<Network className="size-3.5" />}
    >
      <div className="flex flex-col gap-3 py-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-bold text-muted-foreground">
            {t("hosts.tunnelType")}
          </label>
          <div className="flex gap-2">
            {(["remote", "local", "dynamic"] as const).map((m) => (
              <button
                key={m}
                onClick={() => update({ mode: m })}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border transition-colors ${mode === m ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                {m}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
            {t(MODE_DESCRIPTION_KEYS[mode])}
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {mode !== "dynamic" && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold text-muted-foreground">
                {t("hosts.endpointHost")}
              </label>
              <Input
                className="h-7 text-xs border border-border bg-background px-2 outline-none focus:ring-1 focus:ring-ring"
                list={endpointInputId}
                placeholder={t("hosts.endpointHostPlaceholder")}
                value={tunnel.endpointHost ?? ""}
                onChange={(e) => update({ endpointHost: e.target.value })}
              />
              <datalist id={endpointInputId}>
                {hosts
                  .filter((h) => h.enableSsh !== false)
                  .map((h) => (
                    <option key={h.id} value={h.ip}>
                      {h.name || h.ip} ({h.ip})
                    </option>
                  ))}
              </datalist>
            </div>
          )}
          {mode !== "dynamic" && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold text-muted-foreground">
                {t("hosts.endpointPort")}
              </label>
              <Input
                className={numberInputClass}
                type="number"
                value={tunnel.endpointPort}
                onChange={(e) =>
                  update({
                    endpointPort: Number(e.target.value),
                  })
                }
              />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-muted-foreground">
              {t("hosts.bindHost")}
            </label>
            <Input
              className="h-7 text-xs"
              placeholder="127.0.0.1"
              value={tunnel.bindHost ?? ""}
              onChange={(e) => update({ bindHost: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-muted-foreground">
              {t("hosts.sourcePort")}
            </label>
            <Input
              className={numberInputClass}
              type="number"
              value={tunnel.sourcePort}
              onChange={(e) => update({ sourcePort: Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-muted-foreground">
              {t("hosts.maxRetries")}
            </label>
            <Input
              className={numberInputClass}
              type="number"
              value={tunnel.maxRetries}
              onChange={(e) => update({ maxRetries: Number(e.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-muted-foreground">
              {t("hosts.retryIntervalS")}
            </label>
            <Input
              className={numberInputClass}
              type="number"
              value={tunnel.retryInterval}
              onChange={(e) =>
                update({
                  retryInterval: Number(e.target.value),
                })
              }
            />
          </div>
        </div>
        <SettingRow
          label={t("hosts.autoStartLabel")}
          description={t("hosts.autoStartDesc")}
        >
          <FakeSwitch
            checked={tunnel.autoStart}
            onChange={(value) => update({ autoStart: value })}
          />
        </SettingRow>
      </div>
    </SectionCard>
  );
}
