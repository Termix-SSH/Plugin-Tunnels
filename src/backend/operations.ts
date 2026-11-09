import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { TunnelsAccess } from "./service.js";

/** Everything Tunnels offers to the rest of Termix. Tunnels are named per server. */
export function registerOperations(
  ctx: PluginContext,
  tunnels: TunnelsAccess,
): void {
  if (typeof ctx.operations?.register !== "function") return;

  const nameOf = (input: Record<string, unknown>) => {
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("Pick a tunnel");
    return name;
  };

  ctx.operations.register("tunnels.list", {
    run: async () => {
      const all = await tunnels.list();
      const rows = Object.entries(all).map(([name, status]) => ({
        name,
        status: status.connected ? "connected" : status.status,
        reason: status.reason ?? "",
      }));
      return {
        summary: `${rows.length} tunnels`,
        data: {
          rows,
          // optionsFrom reads these as choices.
          options: rows.map((row) => ({ value: row.name, label: row.name })),
        },
      };
    },
  });

  ctx.operations.register("tunnels.down", {
    run: async () => {
      const all = Object.values(await tunnels.list());
      const down = all.filter(
        (status) => !status.connected && status.status !== "disconnected",
      ).length;
      return {
        summary: `${down} tunnels down`,
        data: {
          value: down,
          status: down > 0 ? "warn" : "ok",
          label: `${all.length - down} of ${all.length} up`,
        },
      };
    },
  });

  ctx.operations.register("tunnels.connect", {
    describe: (input) => `Would connect tunnel ${nameOf(input)}`,
    run: async (input) => {
      const name = nameOf(input);
      await tunnels.start(name);
      return {
        summary: `Connecting ${name}`,
        changed: true,
        undoInput: { name },
      };
    },
  });

  ctx.operations.register("tunnels.disconnect", {
    describe: (input) => `Would disconnect tunnel ${nameOf(input)}`,
    run: async (input) => {
      const name = nameOf(input);
      await tunnels.stop(name);
      return {
        summary: `Disconnected ${name}`,
        changed: true,
        undoInput: { name },
      };
    },
  });
}
