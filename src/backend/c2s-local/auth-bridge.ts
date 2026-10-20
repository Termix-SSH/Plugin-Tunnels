import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { PluginSshPromptRequest } from "@termix-ssh/plugin-sdk/backend";

export type AuthEvent =
  | {
      type: "auth-prompt";
      id: string;
      tunnelName: string;
      request: PluginSshPromptRequest;
    }
  | { type: "auth-prompt-closed"; id: string };

const PROMPT_KINDS = ["totp", "input", "browser"]; // plugin-id-ok: SSH prompt kind, not the plugin
const PROMPT_TIMEOUT_MS = 60_000;

interface Pending {
  finish: (answer: string | null) => void;
  /** The events socket the prompt went to. */
  target: object;
}

/**
 * Passes the relay's sign-in prompts (a code, a password) to the plugin's
 * open window and sends the answer back. One window answers one prompt at a
 * time; with no window open the relay socket is closed.
 */
export function createAuthBridge(deps: {
  /** Sends to the newest open window, or returns null when there is none. */
  deliver: (event: AuthEvent) => object | null;
}) {
  const pending = new Map<string, Pending>();

  function answer(id: string, value: unknown): boolean {
    const item = pending.get(id);
    if (!item) return false;
    if (value !== null && (typeof value !== "string" || value.length > 8192)) {
      return false;
    }
    item.finish(value as string | null);
    return true;
  }

  /** The window that held these prompts went away. */
  function dropTarget(target: object): void {
    for (const item of [...pending.values()]) {
      if (item.target === target) item.finish(null);
    }
  }

  function attach(ws: WebSocket, tunnelName: string): void {
    const active = new Set<string>();
    const close = () => {
      for (const id of active) pending.get(id)?.finish(null);
      ws.off("message", onMessage);
      ws.off("close", close);
      ws.off("error", close);
    };
    const onMessage = (raw: unknown, binary: boolean) => {
      if (binary) return;
      let message: {
        type?: string;
        requestId?: unknown;
        request?: PluginSshPromptRequest;
      };
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type !== "auth-prompt") return;
      if (
        active.size ||
        typeof message.requestId !== "string" ||
        !message.request ||
        !PROMPT_KINDS.includes(message.request.kind)
      ) {
        ws.close();
        return;
      }
      const requestId = message.requestId;
      const id = randomUUID();
      const target = deps.deliver({
        type: "auth-prompt",
        id,
        tunnelName,
        request: message.request,
      });
      if (!target) {
        ws.close();
        return;
      }
      const finish = (value: string | null) => {
        if (!pending.delete(id)) return;
        active.delete(id);
        clearTimeout(timer);
        deps.deliver({ type: "auth-prompt-closed", id });
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: "auth-response",
              requestId,
              answer: value,
            }),
          );
        }
        if (value === null) ws.close();
      };
      const timer = setTimeout(() => finish(null), PROMPT_TIMEOUT_MS);
      timer.unref?.();
      active.add(id);
      pending.set(id, { finish, target });
    };
    ws.on("message", onMessage);
    ws.once("close", close);
    ws.once("error", close);
  }

  function dispose(): void {
    for (const item of [...pending.values()]) item.finish(null);
  }

  return { attach, answer, dropTarget, dispose };
}
