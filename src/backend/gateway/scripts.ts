import { ifaceName, isIpv4, privateWgIp, publicWgIp } from "./wg.js";

export interface ScriptPort {
  proto: "tcp" | "udp" | "both";
  publicPort: number;
  /** Empty means the private host itself. */
  targetHost: string;
  targetPort: number;
}

export interface PublicSide {
  gatewayId: number;
  listenPort: number;
  privateKey: string;
  peerPublicKey: string;
  ports: ScriptPort[];
}

export interface PrivateSide {
  gatewayId: number;
  endpoint: string;
  listenPort: number;
  privateKey: string;
  peerPublicKey: string;
}

const KEY = /^[A-Za-z0-9+/]{43}=$/;

function assertKey(value: string): void {
  if (!KEY.test(value)) throw new Error("Invalid WireGuard key");
}

/** The address a rule sends traffic to inside the tunnel or the LAN. */
export function destinationFor(gatewayId: number, targetHost: string): string {
  if (!targetHost) return privateWgIp(gatewayId);
  if (!isIpv4(targetHost)) throw new Error(`Invalid target ${targetHost}`);
  return targetHost;
}

function protos(proto: ScriptPort["proto"]): Array<"tcp" | "udp"> {
  return proto === "both" ? ["tcp", "udp"] : [proto];
}

export function publicWgConf(side: PublicSide): string {
  assertKey(side.privateKey);
  assertKey(side.peerPublicKey);
  const allowed = new Set([`${privateWgIp(side.gatewayId)}/32`]);
  for (const port of side.ports) {
    if (port.targetHost) {
      allowed.add(`${destinationFor(side.gatewayId, port.targetHost)}/32`);
    }
  }
  return [
    "[Interface]",
    `Address = ${publicWgIp(side.gatewayId)}/30`,
    `ListenPort = ${side.listenPort}`,
    `PrivateKey = ${side.privateKey}`,
    "",
    "[Peer]",
    `PublicKey = ${side.peerPublicKey}`,
    `AllowedIPs = ${[...allowed].join(", ")}`,
    "",
  ].join("\n");
}

export function privateWgConf(side: PrivateSide): string {
  assertKey(side.privateKey);
  assertKey(side.peerPublicKey);
  return [
    "[Interface]",
    `Address = ${privateWgIp(side.gatewayId)}/30`,
    `PrivateKey = ${side.privateKey}`,
    "",
    "[Peer]",
    `PublicKey = ${side.peerPublicKey}`,
    `Endpoint = ${side.endpoint}:${side.listenPort}`,
    `AllowedIPs = ${publicWgIp(side.gatewayId)}/32`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

function tableName(gatewayId: number): string {
  return `termix_gw_${gatewayId}`;
}

/** The nftables rules on the public host: DNAT in, masquerade into the tunnel. */
export function publicNft(gatewayId: number, ports: ScriptPort[]): string {
  const iface = ifaceName(gatewayId);
  const table = tableName(gatewayId);
  const dnat: string[] = [];
  for (const port of ports) {
    const to = destinationFor(gatewayId, port.targetHost);
    for (const proto of protos(port.proto)) {
      dnat.push(
        `    iifname != "${iface}" ${proto} dport ${port.publicPort} dnat to ${to}:${port.targetPort}`,
      );
    }
  }
  return [
    `add table ip ${table}`,
    `delete table ip ${table}`,
    `table ip ${table} {`,
    "  chain prerouting {",
    "    type nat hook prerouting priority dstnat; policy accept;",
    ...dnat,
    "  }",
    "  chain postrouting {",
    "    type nat hook postrouting priority srcnat; policy accept;",
    `    oifname "${iface}" masquerade`,
    "  }",
    "  chain forward {",
    "    type filter hook forward priority -10; policy accept;",
    `    oifname "${iface}" accept`,
    `    iifname "${iface}" ct state established,related accept`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/** The nftables rules on the private host: forward and masquerade to the LAN. */
export function privateNft(gatewayId: number): string {
  const iface = ifaceName(gatewayId);
  const table = tableName(gatewayId);
  return [
    `add table ip ${table}`,
    `delete table ip ${table}`,
    `table ip ${table} {`,
    "  chain postrouting {",
    "    type nat hook postrouting priority srcnat; policy accept;",
    `    iifname "${iface}" oifname != "${iface}" masquerade`,
    "  }",
    "  chain forward {",
    "    type filter hook forward priority -10; policy accept;",
    `    iifname "${iface}" accept`,
    `    oifname "${iface}" ct state established,related accept`,
    "  }",
    "}",
    "",
  ].join("\n");
}

function applyScript(gatewayId: number, withDocker: boolean): string {
  const iface = ifaceName(gatewayId);
  const lines = ["#!/bin/sh", `nft -f /etc/termix-gateway/${iface}.nft`];
  if (withDocker) {
    lines.push(
      "if command -v iptables >/dev/null 2>&1 && iptables -n -L DOCKER-USER >/dev/null 2>&1; then",
      `  for r in "-i ${iface}" "-o ${iface}"; do`,
      "    iptables -C DOCKER-USER $r -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER $r -j ACCEPT",
      "  done",
      "fi",
    );
  }
  lines.push("");
  return lines.join("\n");
}

function unit(gatewayId: number): string {
  const iface = ifaceName(gatewayId);
  return [
    "[Unit]",
    `Description=Termix gateway rules for ${iface}`,
    `After=network-online.target wg-quick@${iface}.service docker.service`,
    `Wants=wg-quick@${iface}.service`,
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=/bin/sh /etc/termix-gateway/${iface}.sh`,
    `ExecStop=-/usr/sbin/nft delete table ip ${tableName(gatewayId)}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function installScript(options: {
  gatewayId: number;
  wgConf: string;
  nft: string;
  withDocker: boolean;
}): string {
  const { gatewayId } = options;
  const iface = ifaceName(gatewayId);
  const file = (path: string, body: string, tag: string) =>
    `cat > ${path} <<'${tag}'\n${body.replace(/\n$/, "")}\n${tag}`;
  return [
    "set -e",
    'command -v wg >/dev/null 2>&1 || { echo "MISSING:wireguard-tools"; exit 12; }',
    'command -v nft >/dev/null 2>&1 || { echo "MISSING:nftables"; exit 12; }',
    'command -v systemctl >/dev/null 2>&1 || { echo "MISSING:systemd"; exit 12; }',
    "mkdir -p /etc/wireguard /etc/termix-gateway",
    "umask 077",
    file(`/etc/wireguard/${iface}.conf`, options.wgConf, "TXWG"),
    "umask 022",
    file(`/etc/termix-gateway/${iface}.nft`, options.nft, "TXNFT"),
    file(
      `/etc/termix-gateway/${iface}.sh`,
      applyScript(gatewayId, options.withDocker),
      "TXSH",
    ),
    file(
      `/etc/systemd/system/termix-gateway-${iface}.service`,
      unit(gatewayId),
      "TXUNIT",
    ),
    "echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-termix-gateway.conf",
    "sysctl -w net.ipv4.ip_forward=1 >/dev/null",
    "systemctl daemon-reload",
    `if ip link show ${iface} >/dev/null 2>&1; then`,
    `  wg syncconf ${iface} <(wg-quick strip ${iface})`,
    "else",
    `  systemctl enable --now wg-quick@${iface}`,
    "fi",
    `systemctl enable termix-gateway-${iface}.service >/dev/null 2>&1`,
    `systemctl restart termix-gateway-${iface}.service`,
    "echo TX_APPLIED",
    "",
  ].join("\n");
}

export function publicInstallScript(side: PublicSide): string {
  return installScript({
    gatewayId: side.gatewayId,
    wgConf: publicWgConf(side),
    nft: publicNft(side.gatewayId, side.ports),
    withDocker: true,
  });
}

export function privateInstallScript(side: PrivateSide): string {
  return installScript({
    gatewayId: side.gatewayId,
    wgConf: privateWgConf(side),
    nft: privateNft(side.gatewayId),
    withDocker: false,
  });
}

/** Removes everything a gateway put on a host. */
export function teardownScript(gatewayId: number): string {
  const iface = ifaceName(gatewayId);
  return [
    `systemctl disable --now termix-gateway-${iface}.service >/dev/null 2>&1 || true`,
    `systemctl disable --now wg-quick@${iface} >/dev/null 2>&1 || true`,
    `nft delete table ip ${tableName(gatewayId)} >/dev/null 2>&1 || true`,
    "if command -v iptables >/dev/null 2>&1; then",
    `  for r in "-i ${iface}" "-o ${iface}"; do`,
    "    iptables -D DOCKER-USER $r -j ACCEPT 2>/dev/null || true",
    "  done",
    "fi",
    `rm -f /etc/wireguard/${iface}.conf /etc/termix-gateway/${iface}.nft /etc/termix-gateway/${iface}.sh /etc/systemd/system/termix-gateway-${iface}.service`,
    "systemctl daemon-reload",
    "echo TX_REMOVED",
    "",
  ].join("\n");
}

/** Reads the tunnel and rule state of one end. */
export function healthScript(gatewayId: number): string {
  const iface = ifaceName(gatewayId);
  return [
    `if ip link show ${iface} >/dev/null 2>&1; then echo "iface=1"; else echo "iface=0"; fi`,
    `echo "handshake=$(wg show ${iface} latest-handshakes 2>/dev/null | awk '{print $2}' | sort -n | tail -1)"`,
    `echo "rules=$(nft list table ip ${tableName(gatewayId)} 2>/dev/null | grep -c dnat)"`,
    `echo "now=$(date +%s)"`,
    "",
  ].join("\n");
}

export interface HealthReading {
  iface: boolean;
  /** Unix seconds of the last handshake, 0 when none. */
  handshake: number;
  rules: number;
  now: number;
}

export function parseHealth(output: string): HealthReading {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) {
      values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }
  const num = (key: string) => Number(values.get(key)) || 0;
  return {
    iface: values.get("iface") === "1",
    handshake: num("handshake"),
    rules: num("rules"),
    now: num("now"),
  };
}

/** Which of these target ports answer from the private host, tcp only. */
export function probeScript(
  checks: Array<{ id: number; host: string; port: number }>,
): string {
  return (
    checks
      .map((check) => {
        if (!isIpv4(check.host) || !Number.isInteger(check.port)) {
          throw new Error("Invalid probe target");
        }
        return `if timeout 2 bash -c 'exec 3<>/dev/tcp/${check.host}/${check.port}' 2>/dev/null; then echo "up:${check.id}"; else echo "down:${check.id}"; fi`;
      })
      .join("\n") + "\n"
  );
}

export function parseProbe(output: string): Map<number, boolean> {
  const result = new Map<number, boolean>();
  for (const line of output.split("\n")) {
    const match = /^(up|down):(\d+)$/.exec(line.trim());
    if (match) result.set(Number(match[2]), match[1] === "up");
  }
  return result;
}
