export type TunnelScope = "s2s" | "c2s";
export type TunnelMode = "local" | "remote" | "dynamic";

export const CONNECTION_STATES = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  VERIFYING: "verifying",
  FAILED: "failed",
  UNSTABLE: "unstable",
  RETRYING: "retrying",
  WAITING: "waiting",
  DISCONNECTING: "disconnecting",
} as const;

type ConnectionState =
  (typeof CONNECTION_STATES)[keyof typeof CONNECTION_STATES];

export type TunnelErrorType =
  | "CONNECTION_FAILED"
  | "AUTHENTICATION_FAILED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UNKNOWN";

/** One saved tunnel, as a host's tunnelConnections setting or a C2S preset holds it. */
export interface TunnelConnection {
  scope?: TunnelScope;
  mode?: TunnelMode;
  tunnelType?: "local" | "remote";
  localAddress?: string;
  remoteAddress?: string;
  bindHost?: string;
  sourceHostId?: number;
  sourceHostSyncId?: string;
  sourceHostName?: string;
  sourcePort: number;
  endpointPort: number;
  endpointHost?: string;
  targetHost?: string;
  /** Seconds. */
  retryInterval: number;
  maxRetries: number;
  autoStart: boolean;
  displayName?: string;
}

/** What POST /connect takes. Credentials are always resolved server side. */
export interface TunnelConnectRequest {
  name: string;
  sourceHostId: number;
  tunnelIndex: number;
  scope?: TunnelScope;
  mode?: TunnelMode;
  tunnelType?: "local" | "remote";
  bindHost?: string;
  targetHost?: string;
  endpointHost?: string;
  sourcePort: number;
  endpointPort: number;
  maxRetries?: number;
  /** Seconds. */
  retryInterval?: number;
  autoStart?: boolean;
}

export interface TunnelStatus {
  connected: boolean;
  status: ConnectionState;
  retryCount?: number;
  maxRetries?: number;
  nextRetryIn?: number;
  reason?: string;
  errorType?: TunnelErrorType;
  manualDisconnect?: boolean;
  retryExhausted?: boolean;
}

export interface C2STunnelPreset {
  id: number;
  userId: string;
  name: string;
  config: TunnelConnection[];
  platform?: string | null;
  computerName?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One host's saved server tunnels. */
export interface SavedHostTunnels {
  hostId: number;
  connections: TunnelConnection[];
}

export type GatewayState =
  | "pending"
  | "applying"
  | "up"
  | "no_handshake"
  | "rules_missing"
  | "down"
  | "unreachable"
  | "error";

export type GatewayProto = "tcp" | "udp" | "both";

export interface GatewayPort {
  id: number;
  gatewayId: number;
  proto: GatewayProto;
  publicPort: number;
  /** Empty means the private host itself. */
  targetHost: string;
  targetPort: number;
  label: string;
  source: "manual" | "scan";
  sourceHostId: number | null;
  enabled: boolean;
}

export interface GatewayPortStatus {
  listening?: boolean;
  reachable?: boolean;
}

export interface Gateway {
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
  ports: GatewayPort[];
  status: {
    state: GatewayState;
    message: string | null;
    handshakeAge: number | null;
    checkedAt: string | null;
    lastScanAt: string | null;
    ports: Record<number, GatewayPortStatus>;
  };
}

export interface GatewayPreflight {
  root: boolean;
  wireguard: boolean;
  nftables: boolean;
  systemd: boolean;
  packageManager: "apt" | "dnf" | "yum" | "pacman" | null;
}
