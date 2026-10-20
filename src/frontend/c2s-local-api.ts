import type { PluginSshPromptRequest } from "@termix-ssh/plugin-sdk/backend";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

/**
 * Client tunnels on this computer. The desktop app's own backend runs them;
 * these calls reach its /c2s-local routes and one events socket.
 */

export type LocalTunnelStatuses = Record<
  string,
  { connected: boolean; status: string; reason?: string }
>;

export interface LocalTunnelResult {
  success: boolean;
  error?: string;
  code?: string;
  tunnelName?: string;
}

export type LocalAuthEvent =
  | {
      type: "auth-prompt";
      id: string;
      tunnelName?: string;
      request: PluginSshPromptRequest;
    }
  | { type: "auth-prompt-closed"; id: string };

let current: TermixApp | null = null;
let socket: WebSocket | null = null;
let reconnect: ReturnType<typeof setTimeout> | null = null;
const statusListeners = new Set<(statuses: LocalTunnelStatuses) => void>();
const authListeners = new Set<(event: LocalAuthEvent) => void>();

export function setLocalC2S(app: TermixApp | null): void {
  current = app;
  if (!app) closeSocket();
}

/** True in the desktop app, where client tunnels run. */
export function localC2SAvailable(): boolean {
  return current?.desktop.available === true;
}

function api() {
  if (!current) throw new Error("The tunnels plugin is not active");
  return current.api;
}

function closeSocket(): void {
  if (reconnect) clearTimeout(reconnect);
  reconnect = null;
  const open = socket;
  socket = null;
  open?.close();
}

async function connect(): Promise<void> {
  if (!current || socket) return;
  const target = await current.wsUrl("/c2s-local/events");
  if (!target || socket || !current) return;
  const ws = new WebSocket(target.url, target.protocols);
  socket = ws;
  ws.onmessage = (message) => {
    let event: { type?: string; statuses?: LocalTunnelStatuses };
    try {
      event = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (event.type === "statuses" && event.statuses) {
      for (const listener of statusListeners) listener(event.statuses);
    } else if (
      event.type === "auth-prompt" ||
      event.type === "auth-prompt-closed"
    ) {
      for (const listener of authListeners) listener(event as LocalAuthEvent);
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (statusListeners.size + authListeners.size > 0 && current) {
      reconnect = setTimeout(() => void connect().catch(() => {}), 2000);
    }
  };
}

function release(): void {
  if (statusListeners.size + authListeners.size === 0) closeSocket();
}

export function onLocalStatuses(
  listener: (statuses: LocalTunnelStatuses) => void,
): () => void {
  statusListeners.add(listener);
  void connect().catch(() => {});
  return () => {
    statusListeners.delete(listener);
    release();
  };
}

export function onLocalAuthPrompt(
  listener: (event: LocalAuthEvent) => void,
): () => void {
  authListeners.add(listener);
  void connect().catch(() => {});
  return () => {
    authListeners.delete(listener);
    release();
  };
}

export async function answerLocalAuth(
  id: string,
  answer: string | null,
): Promise<void> {
  await api().post("/c2s-local/auth-answer", { id, answer });
}

export async function getLocalConfig(): Promise<unknown[]> {
  const response = await api().get<unknown[]>("/c2s-local/config");
  return Array.isArray(response.data) ? response.data : [];
}

export async function saveLocalConfig(
  config: unknown[],
): Promise<LocalTunnelResult> {
  const response = await api().put<LocalTunnelResult>(
    "/c2s-local/config",
    config,
  );
  return response.data;
}

export async function getLocalStatuses(): Promise<LocalTunnelStatuses> {
  const response = await api().get<LocalTunnelStatuses>("/c2s-local/statuses");
  return response.data || {};
}

export async function getLocalPresetDefaultName(): Promise<string> {
  const response = await api().get<{ name: string }>(
    "/c2s-local/preset-default-name",
  );
  return response.data?.name ?? "";
}

export async function startLocalTunnel(
  tunnel: unknown,
  index: number,
): Promise<LocalTunnelResult> {
  const response = await api().post<LocalTunnelResult>("/c2s-local/start", {
    tunnel,
    index,
  });
  return response.data;
}

export async function testLocalTunnel(
  tunnel: unknown,
  index: number,
): Promise<LocalTunnelResult> {
  const response = await api().post<LocalTunnelResult>("/c2s-local/test", {
    tunnel,
    index,
  });
  return response.data;
}

export async function stopLocalTunnel(
  tunnelName: string,
): Promise<LocalTunnelResult> {
  const response = await api().post<LocalTunnelResult>("/c2s-local/stop", {
    tunnelName,
  });
  return response.data;
}

export async function startLocalAutoStart(): Promise<void> {
  await api().post("/c2s-local/autostart", {});
}
