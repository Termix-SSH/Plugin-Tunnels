import type { ComponentType } from "react";
import type { ExtensionContribution, PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";

export interface TunnelViewProps {
  host?: PluginHostRecord | null;
}
export interface TunnelView extends ExtensionContribution {
  title: string;
  order?: number;
  components: { view: ComponentType<TunnelViewProps> };
}

/** Core assigns pluginId and scopes components to their registering provider. */
export function tunnelViews(entries: ExtensionContribution[]): TunnelView[] {
  return entries.filter((entry): entry is TunnelView =>
    typeof entry.id === "string" &&
    typeof entry.pluginId === "string" &&
    entry.id.startsWith(entry.pluginId + ".") &&
    typeof entry.title === "string" && entry.title.trim().length > 0 &&
    typeof entry.components?.view === "function"
  ).sort((left, right) =>
    (typeof left.order === "number" && Number.isFinite(left.order) ? left.order : 100) -
    (typeof right.order === "number" && Number.isFinite(right.order) ? right.order : 100) ||
    left.id.localeCompare(right.id)
  );
}

export interface TunnelViewRequest {
  viewId: string;
  hostId?: string | number;
}
const listeners = new Set<(request: TunnelViewRequest) => void>();

/** Refocusing an existing tab must reveal the requested section again. */
export function revealTunnelView(request: TunnelViewRequest): void {
  for (const listener of listeners) listener(request);
}
export function onTunnelViewRequest(listener: (request: TunnelViewRequest) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
