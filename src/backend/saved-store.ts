import { and, eq } from "drizzle-orm";
import type { PluginDatabase } from "@termix-ssh/plugin-sdk/backend";
import type { TunnelConnection } from "./types.js";
import { readTunnelConnections } from "./connections.js";

export interface SavedTunnels {
  hostId: number;
  userId: string;
  connections: TunnelConnection[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type SavedTunnelStore = ReturnType<typeof createSavedTunnelStore>;

/** Each host's saved server tunnels, one row per host. */
export function createSavedTunnelStore(db: PluginDatabase, table: Table) {
  const client = () => db.client<Drizzle>();

  const toSaved = (row: {
    hostId: number;
    userId: string;
    connections: string;
  }): SavedTunnels => ({
    hostId: row.hostId,
    userId: row.userId,
    connections: readTunnelConnections(row.connections),
  });

  return {
    async get(hostId: number): Promise<SavedTunnels | null> {
      const drizzle = await client();
      const rows = await drizzle
        .select()
        .from(table)
        .where(eq(table.hostId, hostId))
        .limit(1);
      return rows[0] ? toSaved(rows[0]) : null;
    },

    async listAll(): Promise<SavedTunnels[]> {
      const drizzle = await client();
      return (await drizzle.select().from(table)).map(toSaved);
    },

    async listForUser(userId: string): Promise<SavedTunnels[]> {
      const drizzle = await client();
      const rows = await drizzle
        .select()
        .from(table)
        .where(eq(table.userId, userId));
      return rows.map(toSaved);
    },

    /** Replaces a host's list. An empty list removes the row. */
    async set(
      hostId: number,
      userId: string,
      connections: TunnelConnection[],
      now = new Date().toISOString(),
    ): Promise<void> {
      const drizzle = await client();
      const existing = await drizzle
        .select({ id: table.id })
        .from(table)
        .where(eq(table.hostId, hostId))
        .limit(1);
      if (connections.length === 0) {
        if (existing[0]) {
          await drizzle.delete(table).where(eq(table.hostId, hostId));
        }
      } else if (existing[0]) {
        await drizzle
          .update(table)
          .set({
            userId,
            connections: JSON.stringify(connections),
            updatedAt: now,
          })
          .where(and(eq(table.hostId, hostId)));
      } else {
        await drizzle.insert(table).values({
          hostId,
          userId,
          connections: JSON.stringify(connections),
          updatedAt: now,
        });
      }
      await db.persist();
    },
  };
}
