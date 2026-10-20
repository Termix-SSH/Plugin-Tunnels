import type { TunnelConnection } from "../types.js";

export type C2STunnel = Omit<
  Partial<TunnelConnection>,
  "mode" | "tunnelType"
> & {
  name?: string;
  mode?: string;
  tunnelType?: string;
  localAddress?: string;
  remoteAddress?: string;
  bindHost?: string;
  targetHost?: string;
  sourceHostId?: number;
  sourceHostSyncId?: string;
  sourceHostName?: string;
  endpointHost?: string;
  sourcePort?: number;
  endpointPort?: number;
  sessionId?: string;
  autoStart?: boolean;
};

function address(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

export function localAddress(tunnel: C2STunnel | undefined): string {
  return address(tunnel?.localAddress || tunnel?.bindHost, "127.0.0.1");
}

export function remoteAddress(tunnel: C2STunnel | undefined): string {
  return address(tunnel?.remoteAddress || tunnel?.targetHost, "127.0.0.1");
}

export function tunnelMode(tunnel: C2STunnel): string {
  return tunnel.mode || tunnel.tunnelType || "local";
}

export function normalizeAddresses<T extends C2STunnel>(tunnel: T): T {
  const local = localAddress(tunnel);
  const remote = remoteAddress(tunnel);
  return {
    ...tunnel,
    localAddress: local,
    remoteAddress: remote,
    bindHost: local,
    targetHost: remote,
  };
}

export function tunnelName(tunnel: C2STunnel, index = 0): string {
  if (tunnel.name) return tunnel.name;
  return [
    "c2s",
    index,
    tunnel.sourceHostId || 0,
    tunnelMode(tunnel),
    localAddress(tunnel),
    remoteAddress(tunnel),
    tunnel.sourcePort,
    tunnel.endpointPort || 0,
  ].join("::");
}

export const SESSION_EXPIRED_ERROR =
  "This device was signed out of its server. Sign in again from Sync and try again.";

function isAuthError(message: unknown): boolean {
  const value = String(message || "")
    .trim()
    .toLowerCase();
  return (
    value === "authentication required" ||
    value === "missing authentication token" ||
    value === "invalid token" ||
    value === "session expired" ||
    value === "session not found" ||
    // The relay refuses an unauthenticated upgrade before any message.
    value === "unexpected server response: 401"
  );
}

export function normalizeError(
  message: unknown,
  fallback = "Client tunnel failed",
): string {
  const value = String(message || fallback);
  return isAuthError(value) ? SESSION_EXPIRED_ERROR : value;
}

export interface C2SFailure {
  success: false;
  error: string;
  code?: "REMOTE_SESSION_EXPIRED";
}

export function failure(message: unknown, fallback: string): C2SFailure {
  const error = normalizeError(message, fallback);
  return {
    success: false,
    error,
    ...(error === SESSION_EXPIRED_ERROR
      ? { code: "REMOTE_SESSION_EXPIRED" as const }
      : {}),
  };
}

/** Reads the target out of a SOCKS5 CONNECT request, or null if incomplete. */
export function parseSocks5Target(
  buffer: Buffer,
): { host: string; port: number; bytesRead: number } | null {
  if (buffer.length < 7 || buffer[0] !== 0x05 || buffer[1] !== 0x01) {
    return null;
  }

  const addressType = buffer[3];
  let offset = 4;
  let host: string;

  if (addressType === 0x01) {
    if (buffer.length < offset + 4 + 2) return null;
    host = Array.from(buffer.subarray(offset, offset + 4)).join(".");
    offset += 4;
  } else if (addressType === 0x03) {
    const length = buffer[offset];
    offset += 1;
    if (buffer.length < offset + length + 2) return null;
    host = buffer.subarray(offset, offset + length).toString("utf8");
    offset += length;
  } else if (addressType === 0x04) {
    if (buffer.length < offset + 16 + 2) return null;
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(buffer.readUInt16BE(offset + i).toString(16));
    }
    host = parts.join(":");
    offset += 16;
  } else {
    throw new Error("Unsupported SOCKS5 address type");
  }

  return { host, port: buffer.readUInt16BE(offset), bytesRead: offset + 2 };
}
