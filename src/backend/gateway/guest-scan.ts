import { parseListening, type ListeningPort } from "./scan.js";

/** Guest services below this port are system services, not game servers. */
export const GUEST_MIN_PORT = 1024;

/**
 * Run as root on a Proxmox node. Prints "@@<ip>" for each running VM or
 * container, then what `ss` sees inside it. VMs need the guest agent and jq.
 */
export const GUEST_SCAN_SCRIPT = [
  "command -v qm >/dev/null 2>&1 || command -v pct >/dev/null 2>&1 || exit 0",
  "if command -v qm >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then",
  "  for id in $(qm list 2>/dev/null | awk 'NR>1{print $1}'); do",
  '    [ "$(qm status "$id" 2>/dev/null | awk \'{print $2}\')" = running ] || continue',
  '    ip=$(qm guest cmd "$id" network-get-interfaces 2>/dev/null | jq -r \'.[]? | select(.name != "lo") | ."ip-addresses"[]? | select(."ip-address-type" == "ipv4") | ."ip-address"\' | grep -Ev \'^(127\\.|169\\.254\\.)\' | head -1)',
  '    [ -z "$ip" ] && continue',
  '    echo "@@$ip"',
  '    qm guest exec "$id" --timeout 10 -- ss -Hltun 2>/dev/null | jq -r \'."out-data" // empty\'',
  "  done",
  "fi",
  "if command -v pct >/dev/null 2>&1; then",
  "  for id in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do",
  '    [ "$(pct status "$id" 2>/dev/null | awk \'{print $2}\')" = running ] || continue',
  "    ip=$(pct exec \"$id\" -- hostname -I 2>/dev/null | tr ' ' '\\n' | grep -E '^[0-9]+\\.' | grep -Ev '^(127\\.|169\\.254\\.)' | head -1)",
  '    [ -z "$ip" ] && continue',
  '    echo "@@$ip"',
  '    pct exec "$id" -- ss -Hltun 2>/dev/null',
  "  done",
  "fi",
  "",
].join("\n");

export interface GuestPorts {
  ip: string;
  ports: ListeningPort[];
}

/**
 * Reads GUEST_SCAN_SCRIPT output into the ports each guest listens on. Only
 * listeners on every address count, since a guest is reached on its own
 * address.
 */
export function parseGuestScan(output: string): GuestPorts[] {
  const guests: GuestPorts[] = [];
  let ip: string | null = null;
  let block: string[] = [];
  const flush = () => {
    if (ip) {
      const ports = parseListening(block.join("\n")).filter(
        (entry) => entry.port >= GUEST_MIN_PORT && entry.address === "",
      );
      guests.push({ ip, ports });
    }
    block = [];
  };
  for (const line of output.split("\n")) {
    const marker = /^@@(\d+\.\d+\.\d+\.\d+)$/.exec(line.trim());
    if (marker) {
      flush();
      ip = marker[1];
    } else {
      block.push(line);
    }
  }
  flush();
  return guests;
}
