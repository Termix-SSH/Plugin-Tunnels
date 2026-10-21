export interface ListeningPort {
  proto: "tcp" | "udp";
  /** The address it listens on, "" for every address. */
  address: string;
  port: number;
}

/** Ports nobody wants forwarded to the internet by default. */
export const DEFAULT_IGNORED_PORTS = [
  22, 25, 53, 111, 123, 139, 445, 2049, 3128, 3306, 5353, 5355, 5432, 5900,
  8006, 27017,
];

export const SCAN_COMMAND = "ss -H -tuln 2>/dev/null";

function splitLocal(value: string): { address: string; port: number } | null {
  const index = value.lastIndexOf(":");
  if (index < 0) return null;
  const port = Number(value.slice(index + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let address = value.slice(0, index);
  address = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return { address, port };
}

/**
 * Parses `ss -H -tuln`. Loopback only listeners, IPv6 only listeners and the
 * given extra addresses (such as the tunnel's own) are dropped, because
 * nothing can reach them through a forward.
 */
export function parseListening(
  output: string,
  skipAddresses: string[] = [],
): ListeningPort[] {
  const seen = new Set<string>();
  const result: ListeningPort[] = [];
  for (const line of output.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const proto = cols[0] === "tcp" || cols[0] === "udp" ? cols[0] : null;
    if (!proto) continue;
    if (proto === "tcp" && cols[1] !== "LISTEN") continue;
    const local = splitLocal(cols[4] ?? "");
    if (!local) continue;
    let { address } = local;
    if (address === "*" || address === "0.0.0.0" || address === "::") {
      address = "";
    }
    if (address.includes(":")) continue;
    if (address.startsWith("127.")) continue;
    if (skipAddresses.includes(address)) continue;
    const key = `${proto}:${local.port}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ proto, address, port: local.port });
  }
  return result.sort(
    (a, b) => a.port - b.port || a.proto.localeCompare(b.proto),
  );
}
