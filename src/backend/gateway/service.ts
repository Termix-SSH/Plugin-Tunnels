import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { errorMessage } from "../manager.js";
import type {
  GatewayRepository,
  GatewayRow,
  PortProto,
  PortRow,
} from "./repository.js";
import {
  healthScript,
  parseHealth,
  parseProbe,
  privateInstallScript,
  probeScript,
  publicInstallScript,
  teardownScript,
  type ScriptPort,
} from "./scripts.js";
import { GUEST_SCAN_SCRIPT, parseGuestScan } from "./guest-scan.js";
import {
  DEFAULT_IGNORED_PORTS,
  SCAN_COMMAND,
  parseListening,
  type ListeningPort,
} from "./scan.js";
import {
  defaultListenPort,
  generateWgKeyPair,
  isEndpointAddress,
  isIpv4,
  privateWgIp,
  publicWgIp,
} from "./wg.js";

export type GatewayState =
  | "pending"
  | "applying"
  | "up"
  | "no_handshake"
  | "rules_missing"
  | "down"
  | "unreachable"
  | "error";

export interface PortStatus {
  /** Scan rows only: whether the service was seen listening on the last scan. */
  listening?: boolean;
  /** TCP rows only: whether the target answered from the private host. */
  reachable?: boolean;
}

export interface GatewayStatus {
  state: GatewayState;
  message: string | null;
  /** Seconds since the last handshake, null when there was none. */
  handshakeAge: number | null;
  checkedAt: string | null;
  lastScanAt: string | null;
  ports: Record<number, PortStatus>;
}

export interface GatewayView {
  id: number;
  name: string;
  privateHostId: number;
  publicHostId: number;
  endpoint: string;
  listenPort: number;
  scanEnabled: boolean;
  scanInterval: number;
  autoEnable: boolean;
  scanGuests: boolean;
  sourceHostIds: number[];
  ignoredPorts: number[];
  publicIp: string;
  privateIp: string;
  ports: PortRow[];
  status: GatewayStatus;
}

export interface Preflight {
  root: boolean;
  wireguard: boolean;
  nftables: boolean;
  systemd: boolean;
  packageManager: "apt" | "dnf" | "yum" | "pacman" | null;
}

/** A failure with a message that is safe to show. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

const HEALTH_INTERVAL_MS = 30_000;
const REAPPLY_COOLDOWN_MS = 2 * 60_000;
const STALE_HANDSHAKE_SECONDS = 180;
// wg, nft and ip often live in sbin, which a normal login does not search.
const SBIN = 'export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"; ';
const ROOT_SHELL =
  SBIN +
  'if [ "$(id -u)" = "0" ]; then exec bash -s; else exec sudo -n env PATH="$PATH" bash -s; fi';

/** Keeps key material out of anything shown or logged. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9+/]{43}=/g, "[key]")
    .trim()
    .slice(0, 500);
}

function parseNumbers(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => Number.isInteger(n))
      : [];
  } catch {
    return [];
  }
}

function validPort(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 65535
  );
}

const PROTOS: PortProto[] = ["tcp", "udp", "both"];

export interface CreateGatewayInput {
  name: string;
  privateHostId: number;
  publicHostId: number;
  endpoint: string;
  listenPort?: number;
}

export interface GatewaySettingsInput {
  name?: string;
  endpoint?: string;
  listenPort?: number;
  scanEnabled?: boolean;
  scanInterval?: number;
  autoEnable?: boolean;
  scanGuests?: boolean;
  sourceHostIds?: number[];
  ignoredPorts?: number[];
}

export interface PortInput {
  proto?: PortProto;
  publicPort?: number;
  targetHost?: string;
  targetPort?: number;
  label?: string;
  enabled?: boolean;
  force?: boolean;
}

export type GatewayService = ReturnType<typeof createGatewayService>;

/**
 * WireGuard gateways: a private host dials a public host over WireGuard and
 * public ports on the public host are forwarded back to services behind the
 * private host. Everything is applied over SSH as root (or passwordless sudo)
 * and lives in its own interface, nftables table and systemd unit per gateway,
 * so nothing else on either host is touched.
 */
export function createGatewayService(
  ctx: PluginContext,
  repo: GatewayRepository,
) {
  const statuses = new Map<number, GatewayStatus>();
  const lastApply = new Map<number, number>();
  const lastScan = new Map<number, number>();
  const locks = new Map<number, Promise<unknown>>();
  const listening = new Map<number, Set<string>>();

  const initialStatus = (): GatewayStatus => ({
    state: "pending",
    message: null,
    handshakeAge: null,
    checkedAt: null,
    lastScanAt: null,
    ports: {},
  });

  const statusOf = (id: number): GatewayStatus => {
    let status = statuses.get(id);
    if (!status) {
      status = initialStatus();
      statuses.set(id, status);
    }
    return status;
  };

  /** Runs jobs for one gateway one at a time. */
  function withLock<T>(id: number, job: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.then(job, job);
    locks.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  async function root(
    hostId: number,
    script: string,
    timeoutMs = 90_000,
  ): Promise<string> {
    const result = await ctx.ssh.exec(hostId, ROOT_SHELL, {
      stdin: script,
      timeoutMs,
      purpose: "tunnels-gateway",
    });
    if (result.timedOut) throw new GatewayError("The host took too long");
    if (result.code !== 0) {
      const stderr = result.stderr;
      if (
        /password is required|a terminal is required|no tty present/i.test(
          stderr,
        )
      ) {
        throw new GatewayError(
          "This host needs passwordless sudo, or a root login",
          400,
          { code: "sudo" },
        );
      }
      const missing = /MISSING:([\w-]+)/.exec(result.stdout);
      if (missing) {
        throw new GatewayError(`${missing[1]} is not installed`, 400, {
          code: "missing",
          missing: missing[1],
        });
      }
      throw new GatewayError(
        scrub(stderr || result.stdout) || "Command failed",
      );
    }
    return result.stdout;
  }

  async function plain(hostId: number, command: string): Promise<string> {
    const result = await ctx.ssh.exec(hostId, SBIN + command, {
      timeoutMs: 20_000,
      purpose: "tunnels-gateway",
    });
    return result.stdout;
  }

  async function accessibleHost(hostId: number) {
    const access = await ctx.hosts.checkAccess(hostId, "edit");
    const host = access.hasAccess ? await ctx.hosts.get(hostId) : null;
    if (!host) throw new GatewayError("Access denied to this host", 403);
    return host;
  }

  async function preflight(hostId: number): Promise<Preflight> {
    await accessibleHost(hostId);
    const out = await plain(
      hostId,
      [
        'if [ "$(id -u)" = "0" ] || sudo -n true 2>/dev/null; then echo root=1; else echo root=0; fi',
        "command -v wg >/dev/null 2>&1 && echo wg=1 || echo wg=0",
        "command -v nft >/dev/null 2>&1 && echo nft=1 || echo nft=0",
        "command -v systemctl >/dev/null 2>&1 && echo systemd=1 || echo systemd=0",
        "if command -v apt-get >/dev/null 2>&1; then echo pm=apt; elif command -v dnf >/dev/null 2>&1; then echo pm=dnf; elif command -v yum >/dev/null 2>&1; then echo pm=yum; elif command -v pacman >/dev/null 2>&1; then echo pm=pacman; else echo pm=; fi",
      ].join("; "),
    );
    const values = new Map<string, string>();
    for (const line of out.split("\n")) {
      const index = line.indexOf("=");
      if (index > 0)
        values.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
    const pm = values.get("pm");
    return {
      root: values.get("root") === "1",
      wireguard: values.get("wg") === "1",
      nftables: values.get("nft") === "1",
      systemd: values.get("systemd") === "1",
      packageManager:
        pm === "apt" || pm === "dnf" || pm === "yum" || pm === "pacman"
          ? pm
          : null,
    };
  }

  async function installDependencies(hostId: number): Promise<void> {
    const state = await preflight(hostId);
    if (!state.root) {
      throw new GatewayError(
        "This host needs passwordless sudo, or a root login",
        400,
        { code: "sudo" },
      );
    }
    const commands: Record<string, string> = {
      apt: "DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools nftables",
      dnf: "dnf install -y wireguard-tools nftables",
      yum: "yum install -y wireguard-tools nftables",
      pacman: "pacman -S --noconfirm wireguard-tools nftables",
    };
    if (!state.packageManager) {
      throw new GatewayError("No supported package manager found on this host");
    }
    await root(hostId, `${commands[state.packageManager]}\n`, 240_000);
  }

  async function sealed(value: string): Promise<string> {
    return ctx.secrets.seal(value);
  }

  async function open(value: string): Promise<string> {
    const plainValue = await ctx.secrets.unseal(value);
    if (!plainValue) throw new GatewayError("A gateway key could not be read");
    return plainValue;
  }

  function scriptPorts(ports: PortRow[]): ScriptPort[] {
    return ports
      .filter((port) => port.enabled)
      .map((port) => ({
        proto: port.proto,
        publicPort: port.publicPort,
        targetHost: port.targetHost,
        targetPort: port.targetPort,
      }));
  }

  /** Writes the config and rules on both hosts, public end first. */
  async function applyNow(id: number): Promise<void> {
    const gateway = await repo.getGateway(id);
    if (!gateway) throw new GatewayError("Gateway not found", 404);
    const status = statusOf(id);
    status.state = "applying";
    status.message = null;
    try {
      await ctx.asUser(gateway.userId, async () => {
        const ports = await repo.listPorts(id);
        const publicKey = await open(gateway.privateKey);
        const privateKey = await open(gateway.peerPrivateKey);
        await root(
          gateway.publicHostId,
          publicInstallScript({
            gatewayId: id,
            listenPort: gateway.listenPort,
            privateKey: publicKey,
            peerPublicKey: gateway.peerPublicKey,
            ports: scriptPorts(ports),
          }),
        );
        await root(
          gateway.privateHostId,
          privateInstallScript({
            gatewayId: id,
            endpoint: gateway.endpoint,
            listenPort: gateway.listenPort,
            privateKey,
            peerPublicKey: gateway.publicKey,
          }),
        );
      });
      lastApply.set(id, Date.now());
      status.state = "pending";
    } catch (error) {
      lastApply.set(id, Date.now());
      status.state = "error";
      status.message = scrub(errorMessage(error));
      throw error;
    }
  }

  function apply(id: number): Promise<void> {
    return withLock(id, () => applyNow(id));
  }

  /** The public ports something already listens on, on the public host. */
  async function publicListeners(hostId: number): Promise<Set<number>> {
    const out = await plain(hostId, SCAN_COMMAND);
    return new Set(parseListening(out).map((entry) => entry.port));
  }

  async function checkNow(id: number): Promise<void> {
    const gateway = await repo.getGateway(id);
    if (!gateway) return;
    const status = statusOf(id);
    if (status.state === "applying") return;
    const ports = await repo.listPorts(id);
    const expected = scriptPorts(ports).reduce(
      (sum, port) => sum + (port.proto === "both" ? 2 : 1),
      0,
    );

    await ctx.asUser(gateway.userId, async () => {
      let pub;
      let priv;
      try {
        pub = parseHealth(
          await root(gateway.publicHostId, healthScript(id), 30_000),
        );
      } catch (error) {
        status.state = "unreachable";
        status.message = `Public host: ${scrub(errorMessage(error))}`;
        status.checkedAt = new Date().toISOString();
        return;
      }
      try {
        priv = parseHealth(
          await root(gateway.privateHostId, healthScript(id), 30_000),
        );
      } catch (error) {
        status.state = "unreachable";
        status.message = `Private host: ${scrub(errorMessage(error))}`;
        status.checkedAt = new Date().toISOString();
        return;
      }

      const handshake = Math.max(pub.handshake, priv.handshake);
      status.handshakeAge =
        handshake > 0 ? Math.max(0, pub.now - handshake) : null;
      status.message = null;
      let needsApply = false;
      if (!pub.iface || !priv.iface) {
        status.state = "down";
        status.message = !pub.iface
          ? "The tunnel is down on the public host"
          : "The tunnel is down on the private host";
        needsApply = true;
      } else if (pub.rules !== expected) {
        status.state = "rules_missing";
        status.message = "Forwarding rules are missing on the public host";
        needsApply = true;
      } else if (
        status.handshakeAge === null ||
        status.handshakeAge > STALE_HANDSHAKE_SECONDS
      ) {
        status.state = "no_handshake";
        status.message = "The two hosts are not talking yet";
      } else {
        status.state = "up";
      }
      status.checkedAt = new Date().toISOString();

      // Which TCP targets answer from the private host.
      const checks = ports
        .filter((port) => port.enabled && port.proto !== "udp")
        .map((port) => ({
          id: port.id,
          host: port.targetHost || "127.0.0.1",
          port: port.targetPort,
        }))
        .filter((check) => isIpv4(check.host));
      const next: Record<number, PortStatus> = {};
      for (const port of ports) {
        const seen = listening.get(id);
        next[port.id] =
          port.source === "scan" && seen
            ? { listening: seen.has(listeningKey(port)) }
            : {};
      }
      if (checks.length > 0 && priv.iface) {
        try {
          const probed = parseProbe(
            await root(gateway.privateHostId, probeScript(checks), 60_000),
          );
          for (const [portId, ok] of probed) {
            next[portId] = { ...next[portId], reachable: ok };
          }
        } catch {
          // The tunnel state above already says what is wrong.
        }
      }
      status.ports = next;

      const cooled =
        Date.now() - (lastApply.get(id) ?? 0) > REAPPLY_COOLDOWN_MS;
      if (needsApply && cooled) {
        ctx.log.info(`Gateway ${gateway.name} drifted, applying it again`);
        try {
          await applyNow(id);
        } catch (error) {
          ctx.log.warn(
            `Gateway ${gateway.name} could not be applied: ${scrub(errorMessage(error))}`,
          );
        }
      }
    });
  }

  function listeningKey(port: PortRow): string {
    return `${port.sourceHostId ?? "g"}:${port.targetHost}:${port.targetPort}`;
  }

  async function scanNow(id: number): Promise<number> {
    const gateway = await repo.getGateway(id);
    if (!gateway) throw new GatewayError("Gateway not found", 404);
    const ignored = new Set([
      ...DEFAULT_IGNORED_PORTS,
      gateway.listenPort,
      ...parseNumbers(gateway.ignoredPorts),
    ]);
    const sources = [
      gateway.privateHostId,
      ...parseNumbers(gateway.sourceHostIds).filter(
        (hostId) => hostId !== gateway.privateHostId,
      ),
    ];
    const skipAddresses = [publicWgIp(id), privateWgIp(id)];

    return ctx.asUser(gateway.userId, async () => {
      const existing = await repo.listPorts(id);
      const usedPublic = new Set(existing.map((port) => port.publicPort));
      const seenNow = new Set<string>();
      let publicBusy: Set<number> | null = null;
      let added = 0;
      let enabledAny = false;

      interface Candidate {
        sourceHostId: number | null;
        // Empty means a service on the private host itself.
        targetHost: string;
        entries: ListeningPort[];
        minPort: number;
      }
      const candidates: Candidate[] = [];

      for (const sourceId of sources) {
        const host = await ctx.hosts.get(sourceId);
        if (!host) continue;
        try {
          const found = parseListening(
            await plain(sourceId, SCAN_COMMAND),
            skipAddresses,
          );
          const isRouter = sourceId === gateway.privateHostId;
          if (isRouter) {
            // A service bound to one address is reached on that address.
            for (const entry of found) {
              candidates.push({
                sourceHostId: sourceId,
                targetHost: entry.address,
                entries: [entry],
                minPort: 1,
              });
            }
          } else if (isIpv4(host.ip)) {
            candidates.push({
              sourceHostId: sourceId,
              targetHost: host.ip,
              entries: found,
              minPort: 1,
            });
          }
        } catch (error) {
          ctx.log.warn(
            `Port scan of host ${sourceId} failed: ${scrub(errorMessage(error))}`,
          );
        }
      }

      if (gateway.scanGuests) {
        try {
          const out = await root(
            gateway.privateHostId,
            GUEST_SCAN_SCRIPT,
            120_000,
          );
          for (const guest of parseGuestScan(out)) {
            candidates.push({
              sourceHostId: null,
              targetHost: guest.ip,
              entries: guest.ports,
              minPort: 1,
            });
          }
        } catch (error) {
          ctx.log.warn(
            `Guest scan of host ${gateway.privateHostId} failed: ${scrub(errorMessage(error))}`,
          );
        }
      }

      const keyOf = (
        sourceHostId: number | null,
        targetHost: string,
        port: number,
      ) => `${sourceHostId ?? "g"}:${targetHost}:${port}`;
      const known = new Set(
        existing.map((port) =>
          keyOf(port.sourceHostId, port.targetHost, port.targetPort),
        ),
      );

      for (const candidate of candidates) {
        for (const entry of candidate.entries) {
          const key = keyOf(
            candidate.sourceHostId,
            candidate.targetHost,
            entry.port,
          );
          seenNow.add(key);
          if (ignored.has(entry.port) || known.has(key)) continue;
          if (usedPublic.has(entry.port)) continue;

          let enabled = false;
          if (gateway.autoEnable) {
            try {
              publicBusy ??= await publicListeners(gateway.publicHostId);
              enabled = !publicBusy.has(entry.port);
            } catch {
              enabled = false;
            }
          }
          const sameProto = candidate.entries.filter(
            (other) =>
              other.port === entry.port && other.address === entry.address,
          );
          const proto: PortProto = sameProto.length > 1 ? "both" : entry.proto;
          await repo.insertPort({
            gatewayId: id,
            proto,
            publicPort: entry.port,
            targetHost: candidate.targetHost,
            targetPort: entry.port,
            label: "",
            source: "scan",
            sourceHostId: candidate.sourceHostId,
            enabled,
          });
          usedPublic.add(entry.port);
          known.add(key);
          added++;
          if (enabled) enabledAny = true;
        }
      }
      listening.set(id, seenNow);
      lastScan.set(id, Date.now());
      statusOf(id).lastScanAt = new Date().toISOString();
      if (enabledAny) await applyNow(id);
      return added;
    });
  }

  function scan(id: number): Promise<number> {
    return withLock(id, () => scanNow(id));
  }

  async function view(row: GatewayRow): Promise<GatewayView> {
    return {
      id: row.id,
      name: row.name,
      privateHostId: row.privateHostId,
      publicHostId: row.publicHostId,
      endpoint: row.endpoint,
      listenPort: row.listenPort,
      scanEnabled: Boolean(row.scanEnabled),
      scanInterval: row.scanInterval,
      autoEnable: Boolean(row.autoEnable),
      scanGuests: Boolean(row.scanGuests),
      sourceHostIds: parseNumbers(row.sourceHostIds),
      ignoredPorts: parseNumbers(row.ignoredPorts),
      publicIp: publicWgIp(row.id),
      privateIp: privateWgIp(row.id),
      ports: await repo.listPorts(row.id),
      status: statusOf(row.id),
    };
  }

  async function owned(id: number, userId: string): Promise<GatewayRow> {
    const row = await repo.getGateway(id);
    if (!row || row.userId !== userId) {
      throw new GatewayError("Gateway not found", 404);
    }
    return row;
  }

  function validatePort(input: PortInput, partial: boolean): void {
    if (!partial || input.proto !== undefined) {
      if (!input.proto || !PROTOS.includes(input.proto)) {
        throw new GatewayError("Protocol must be tcp, udp or both");
      }
    }
    if (!partial || input.publicPort !== undefined) {
      if (!validPort(input.publicPort))
        throw new GatewayError("Invalid public port");
    }
    if (!partial || input.targetPort !== undefined) {
      if (!validPort(input.targetPort))
        throw new GatewayError("Invalid target port");
    }
    if (input.targetHost !== undefined && input.targetHost !== "") {
      if (!isIpv4(input.targetHost)) {
        throw new GatewayError(
          "The target must be an IPv4 address, or empty for the private host",
        );
      }
    }
  }

  async function assertNoPortClash(
    gateway: GatewayRow,
    port: { publicPort: number; proto: PortProto },
    ignoreId: number | null,
    force: boolean,
  ): Promise<void> {
    const others = (await repo.listPorts(gateway.id)).filter(
      (other) => other.id !== ignoreId,
    );
    const overlaps = (a: PortProto, b: PortProto) =>
      a === "both" || b === "both" || a === b;
    if (
      others.some(
        (other) =>
          other.publicPort === port.publicPort &&
          overlaps(other.proto, port.proto),
      )
    ) {
      throw new GatewayError(
        "That public port is already used by this gateway",
        409,
      );
    }
    if (port.publicPort === gateway.listenPort) {
      throw new GatewayError("That port is used by the tunnel itself", 409);
    }
    if (!force) {
      let busy: Set<number>;
      try {
        busy = await publicListeners(gateway.publicHostId);
      } catch {
        return;
      }
      if (busy.has(port.publicPort)) {
        throw new GatewayError(
          `Something is already listening on port ${port.publicPort} on the public host`,
          409,
          { code: "conflict" },
        );
      }
    }
  }

  const timers: Array<ReturnType<typeof setInterval>> = [];

  /** Checks every gateway on a timer and scans the ones set to scan. */
  function start(): void {
    const tick = async () => {
      let rows: GatewayRow[];
      try {
        rows = await repo.listGateways();
      } catch {
        return;
      }
      for (const row of rows) {
        try {
          await withLock(row.id, () => checkNow(row.id));
          const due =
            Date.now() - (lastScan.get(row.id) ?? 0) >=
            Math.max(1, row.scanInterval) * 60_000;
          if (row.scanEnabled && due) await scan(row.id);
        } catch (error) {
          ctx.log.warn(
            `Gateway ${row.name} check failed: ${scrub(errorMessage(error))}`,
          );
        }
      }
    };
    const timer = setInterval(() => void tick(), HEALTH_INTERVAL_MS);
    timer.unref?.();
    timers.push(timer);
    // First look soon after boot.
    const first = setTimeout(() => void tick(), 10_000);
    first.unref?.();
    ctx.disposables.add(() => clearTimeout(first));
  }

  function dispose(): void {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
  }

  return {
    start,
    dispose,
    preflight,
    installDependencies,

    async list(userId: string): Promise<GatewayView[]> {
      const rows = await repo.listGateways(userId);
      return Promise.all(rows.map(view));
    },

    async get(id: number, userId: string): Promise<GatewayView> {
      return view(await owned(id, userId));
    },

    async create(
      userId: string,
      input: CreateGatewayInput,
    ): Promise<GatewayView> {
      const name = (input.name ?? "").trim();
      if (!name || name.length > 120) throw new GatewayError("Enter a name");
      if (input.privateHostId === input.publicHostId) {
        throw new GatewayError("Pick two different hosts");
      }
      const endpoint = (input.endpoint ?? "").trim();
      if (!isEndpointAddress(endpoint)) {
        throw new GatewayError("Enter the public address of the public host");
      }
      await accessibleHost(input.privateHostId);
      await accessibleHost(input.publicHostId);

      const checks = await Promise.all([
        preflight(input.privateHostId),
        preflight(input.publicHostId),
      ]);
      for (const check of checks) {
        if (!check.root) {
          throw new GatewayError(
            "Both hosts need a root login or passwordless sudo",
            400,
            { code: "sudo" },
          );
        }
        if (!check.systemd) {
          throw new GatewayError("Both hosts need systemd");
        }
      }

      const server = generateWgKeyPair();
      const client = generateWgKeyPair();
      // The port is fixed after the id is known, since it depends on it.
      const row = await repo.insertGateway({
        userId,
        name,
        privateHostId: input.privateHostId,
        publicHostId: input.publicHostId,
        endpoint,
        listenPort: validPort(input.listenPort) ? input.listenPort : 51830,
        publicKey: server.publicKey,
        privateKey: await sealed(server.privateKey),
        peerPublicKey: client.publicKey,
        peerPrivateKey: await sealed(client.privateKey),
        ignoredPorts: JSON.stringify(DEFAULT_IGNORED_PORTS),
      });
      if (!validPort(input.listenPort)) {
        await repo.updateGateway(row.id, {
          listenPort: defaultListenPort(row.id),
        });
      }
      return view((await repo.getGateway(row.id)) as GatewayRow);
    },

    async update(
      id: number,
      userId: string,
      input: GatewaySettingsInput,
    ): Promise<GatewayView> {
      const row = await owned(id, userId);
      const updates: Parameters<GatewayRepository["updateGateway"]>[1] = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name || name.length > 120) throw new GatewayError("Enter a name");
        updates.name = name;
      }
      if (input.endpoint !== undefined) {
        if (!isEndpointAddress(input.endpoint.trim())) {
          throw new GatewayError("Enter the public address of the public host");
        }
        updates.endpoint = input.endpoint.trim();
      }
      if (input.listenPort !== undefined) {
        if (!validPort(input.listenPort))
          throw new GatewayError("Invalid port");
        updates.listenPort = input.listenPort;
      }
      if (input.scanEnabled !== undefined)
        updates.scanEnabled = input.scanEnabled;
      if (input.autoEnable !== undefined) updates.autoEnable = input.autoEnable;
      if (input.scanGuests !== undefined) updates.scanGuests = input.scanGuests;
      if (input.scanInterval !== undefined) {
        updates.scanInterval = Math.min(
          1440,
          Math.max(1, Math.floor(input.scanInterval) || 10),
        );
      }
      if (input.sourceHostIds !== undefined) {
        for (const hostId of input.sourceHostIds) await accessibleHost(hostId);
        updates.sourceHostIds = JSON.stringify(input.sourceHostIds);
      }
      if (input.ignoredPorts !== undefined) {
        updates.ignoredPorts = JSON.stringify(
          input.ignoredPorts.filter(validPort),
        );
      }
      const updated = (await repo.updateGateway(id, updates)) as GatewayRow;
      const needsApply =
        (updates.endpoint !== undefined && updates.endpoint !== row.endpoint) ||
        (updates.listenPort !== undefined &&
          updates.listenPort !== row.listenPort);
      if (needsApply) await apply(id);
      return view(updated);
    },

    async remove(id: number, userId: string): Promise<void> {
      const row = await owned(id, userId);
      await withLock(id, async () => {
        const errors: string[] = [];
        await ctx.asUser(row.userId, async () => {
          for (const hostId of [row.publicHostId, row.privateHostId]) {
            try {
              await root(hostId, teardownScript(id));
            } catch (error) {
              errors.push(scrub(errorMessage(error)));
            }
          }
        });
        if (errors.length > 0) {
          ctx.log.warn(
            `Gateway ${row.name} removed with leftovers: ${errors.join("; ")}`,
          );
        }
        await repo.deleteGateway(id);
        statuses.delete(id);
        lastApply.delete(id);
        lastScan.delete(id);
        listening.delete(id);
      });
    },

    async apply(id: number, userId: string): Promise<GatewayView> {
      await owned(id, userId);
      await apply(id);
      return view((await repo.getGateway(id)) as GatewayRow);
    },

    async check(id: number, userId: string): Promise<GatewayView> {
      const row = await owned(id, userId);
      await withLock(id, () => checkNow(id));
      return view(row);
    },

    async scan(id: number, userId: string): Promise<number> {
      await owned(id, userId);
      return scan(id);
    },

    async addPort(
      id: number,
      userId: string,
      input: PortInput,
    ): Promise<PortRow> {
      const gateway = await owned(id, userId);
      validatePort(input, false);
      const proto = input.proto as PortProto;
      const publicPort = input.publicPort as number;
      await ctx.asUser(userId, () =>
        assertNoPortClash(
          gateway,
          { publicPort, proto },
          null,
          input.force === true,
        ),
      );
      const row = await repo.insertPort({
        gatewayId: id,
        proto,
        publicPort,
        targetHost: input.targetHost ?? "",
        targetPort: input.targetPort as number,
        label: (input.label ?? "").slice(0, 120),
        source: "manual",
        enabled: input.enabled !== false,
      });
      if (row.enabled) await apply(id);
      return row;
    },

    async updatePort(
      id: number,
      portId: number,
      userId: string,
      input: PortInput,
    ): Promise<PortRow> {
      const gateway = await owned(id, userId);
      const port = await repo.getPort(portId);
      if (!port || port.gatewayId !== id) {
        throw new GatewayError("Port not found", 404);
      }
      validatePort(input, true);
      const next = {
        publicPort: input.publicPort ?? port.publicPort,
        proto: input.proto ?? port.proto,
      };
      const turningOn = input.enabled === true && !port.enabled;
      if (
        input.publicPort !== undefined ||
        input.proto !== undefined ||
        turningOn
      ) {
        await ctx.asUser(userId, () =>
          assertNoPortClash(gateway, next, portId, input.force === true),
        );
      }
      const updated = (await repo.updatePort(portId, {
        ...(input.proto !== undefined ? { proto: input.proto } : {}),
        ...(input.publicPort !== undefined
          ? { publicPort: input.publicPort }
          : {}),
        ...(input.targetHost !== undefined
          ? { targetHost: input.targetHost }
          : {}),
        ...(input.targetPort !== undefined
          ? { targetPort: input.targetPort }
          : {}),
        ...(input.label !== undefined
          ? { label: input.label.slice(0, 120) }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      })) as PortRow;
      if (port.enabled || updated.enabled) await apply(id);
      return updated;
    },

    async removePort(
      id: number,
      portId: number,
      userId: string,
    ): Promise<void> {
      await owned(id, userId);
      const port = await repo.getPort(portId);
      if (!port || port.gatewayId !== id) {
        throw new GatewayError("Port not found", 404);
      }
      await repo.deletePort(portId);
      if (port.enabled) await apply(id);
    },

    /** Used by tests. */
    checkNow: (id: number) => withLock(id, () => checkNow(id)),
    scanNow: scan,
    applyNow: apply,
  };
}
