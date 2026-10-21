import type { Gateway, GatewayPort, GatewayState } from "../shared/types";

export const STATE_KEYS: Record<GatewayState, string> = {
  pending: "gateways.state.pending",
  applying: "gateways.state.applying",
  up: "gateways.state.up",
  no_handshake: "gateways.state.noHandshake",
  rules_missing: "gateways.state.rulesMissing",
  down: "gateways.state.down",
  unreachable: "gateways.state.unreachable",
  error: "gateways.state.error",
};

export type StateTone = "good" | "warn" | "bad" | "idle";

export function stateTone(state: GatewayState): StateTone {
  if (state === "up") return "good";
  if (state === "pending" || state === "applying") return "idle";
  if (state === "no_handshake" || state === "rules_missing") return "warn";
  return "bad";
}

export const TONE_CLASS: Record<StateTone, string> = {
  good: "text-accent-brand border-accent-brand/40 bg-accent-brand/10",
  warn: "text-warning border-warning/40 bg-warning/10",
  bad: "text-destructive border-destructive/40 bg-destructive/10",
  idle: "text-muted-foreground border-border bg-muted/30",
};

/** Where a rule sends traffic, for display. */
export function portTarget(gateway: Gateway, port: GatewayPort): string {
  return `${port.targetHost || gateway.privateIp}:${port.targetPort}`;
}

/** The public ports to open in a cloud firewall, one entry per protocol. */
export function firewallPorts(gateway: Gateway): string[] {
  const entries = new Set<string>();
  for (const port of gateway.ports) {
    if (!port.enabled) continue;
    const protos = port.proto === "both" ? ["tcp", "udp"] : [port.proto];
    for (const proto of protos) entries.add(`${proto} ${port.publicPort}`);
  }
  entries.add(`udp ${gateway.listenPort}`);
  return [...entries].sort((a, b) => {
    const [pa, na] = a.split(" ");
    const [pb, nb] = b.split(" ");
    return Number(na) - Number(nb) || pa.localeCompare(pb);
  });
}

/** Ports in a text box: "25565, 8080" to numbers. Bad entries are dropped. */
export function parsePortList(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
}
