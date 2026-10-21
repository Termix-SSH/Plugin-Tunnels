import { useCallback, useEffect, useState } from "react";
import type { TunnelConnection } from "../shared/types";
import { getSavedTunnels, saveHostTunnels } from "./api";

export interface SavedTunnelsState {
  /** Saved tunnels by host id. Hosts without any are missing. */
  byHost: Map<number, TunnelConnection[]>;
  loaded: boolean;
  reload: () => Promise<void>;
  /** Replaces one host's list, then reloads. */
  save: (hostId: number, connections: TunnelConnection[]) => Promise<void>;
}

const listeners = new Set<() => void>();
let cache: Map<number, TunnelConnection[]> | null = null;

function publish(next: Map<number, TunnelConnection[]>): void {
  cache = next;
  for (const listener of listeners) listener();
}

async function refresh(): Promise<void> {
  const saved = await getSavedTunnels();
  publish(new Map(saved.map((entry) => [entry.hostId, entry.connections])));
}

/** The saved server tunnels of every host the user can reach. */
export function useSavedTunnels(): SavedTunnelsState {
  const [, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion((version) => version + 1);
    listeners.add(listener);
    void refresh().catch(() => {});
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const save = useCallback(
    async (hostId: number, connections: TunnelConnection[]) => {
      await saveHostTunnels(hostId, connections);
      await refresh();
    },
    [],
  );

  return {
    byHost: cache ?? new Map(),
    loaded: cache !== null,
    reload: refresh,
    save,
  };
}

/** Forgets the cached lists, for tests. */
export function resetSavedTunnels(): void {
  cache = null;
  listeners.clear();
}
