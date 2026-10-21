import { and, asc, desc, eq } from "drizzle-orm";
import type { PluginDatabase } from "@termix-ssh/plugin-sdk/backend";

export interface GatewayRow {
  id: number;
  userId: string;
  name: string;
  privateHostId: number;
  publicHostId: number;
  endpoint: string;
  listenPort: number;
  // The public host's pair, then the private host's pair (peer). Private keys
  // are sealed.
  publicKey: string;
  privateKey: string;
  peerPublicKey: string;
  peerPrivateKey: string;
  scanEnabled: boolean;
  scanInterval: number;
  autoEnable: boolean;
  scanGuests: boolean;
  sourceHostIds: string;
  ignoredPorts: string;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayInsert {
  userId: string;
  name: string;
  privateHostId: number;
  publicHostId: number;
  endpoint: string;
  listenPort: number;
  publicKey: string;
  privateKey: string;
  peerPublicKey: string;
  peerPrivateKey: string;
  scanEnabled?: boolean;
  scanInterval?: number;
  autoEnable?: boolean;
  scanGuests?: boolean;
  sourceHostIds?: string;
  ignoredPorts?: string;
}

export type GatewayUpdate = Partial<
  Pick<
    GatewayRow,
    | "name"
    | "endpoint"
    | "listenPort"
    | "scanEnabled"
    | "scanInterval"
    | "autoEnable"
    | "scanGuests"
    | "sourceHostIds"
    | "ignoredPorts"
  >
>;

export type PortProto = "tcp" | "udp" | "both";

export interface PortRow {
  id: number;
  gatewayId: number;
  proto: PortProto;
  publicPort: number;
  targetHost: string;
  targetPort: number;
  label: string;
  source: "manual" | "scan";
  sourceHostId: number | null;
  enabled: boolean;
  createdAt: string;
}

export interface PortInsert {
  gatewayId: number;
  proto: PortProto;
  publicPort: number;
  targetHost?: string;
  targetPort: number;
  label?: string;
  source?: "manual" | "scan";
  sourceHostId?: number | null;
  enabled?: boolean;
}

export type PortUpdate = Partial<
  Pick<
    PortRow,
    "proto" | "publicPort" | "targetHost" | "targetPort" | "label" | "enabled"
  >
>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type GatewayRepository = ReturnType<typeof createGatewayRepository>;

/**
 * Gateways and their ports. No RETURNING, so it runs the same on all three
 * engines: a new row is read back as the newest row that matches.
 */
export function createGatewayRepository(
  db: PluginDatabase,
  gateways: Table,
  ports: Table,
) {
  const client = () => db.client<Drizzle>();

  async function getGateway(id: number): Promise<GatewayRow | null> {
    const drizzle = await client();
    const rows = await drizzle
      .select()
      .from(gateways)
      .where(eq(gateways.id, id))
      .limit(1);
    return (rows[0] as GatewayRow) ?? null;
  }

  async function getPort(id: number): Promise<PortRow | null> {
    const drizzle = await client();
    const rows = await drizzle
      .select()
      .from(ports)
      .where(eq(ports.id, id))
      .limit(1);
    return (rows[0] as PortRow) ?? null;
  }

  return {
    getGateway,
    getPort,

    async listGateways(userId?: string): Promise<GatewayRow[]> {
      const drizzle = await client();
      const query = drizzle.select().from(gateways);
      const rows = userId
        ? await query
            .where(eq(gateways.userId, userId))
            .orderBy(asc(gateways.name))
        : await query.orderBy(asc(gateways.name));
      return rows as GatewayRow[];
    },

    async insertGateway(
      input: GatewayInsert,
      now = new Date().toISOString(),
    ): Promise<GatewayRow> {
      const drizzle = await client();
      await drizzle
        .insert(gateways)
        .values({ ...input, createdAt: now, updatedAt: now });
      await db.persist();
      const rows = await drizzle
        .select()
        .from(gateways)
        .where(
          and(eq(gateways.userId, input.userId), eq(gateways.name, input.name)),
        )
        .orderBy(desc(gateways.id))
        .limit(1);
      return rows[0] as GatewayRow;
    },

    async updateGateway(
      id: number,
      updates: GatewayUpdate,
      now = new Date().toISOString(),
    ): Promise<GatewayRow | null> {
      const drizzle = await client();
      await drizzle
        .update(gateways)
        .set({ ...updates, updatedAt: now })
        .where(eq(gateways.id, id));
      await db.persist();
      return getGateway(id);
    },

    async deleteGateway(id: number): Promise<void> {
      const drizzle = await client();
      await drizzle.delete(ports).where(eq(ports.gatewayId, id));
      await drizzle.delete(gateways).where(eq(gateways.id, id));
      await db.persist();
    },

    async listPorts(gatewayId: number): Promise<PortRow[]> {
      const drizzle = await client();
      return (await drizzle
        .select()
        .from(ports)
        .where(eq(ports.gatewayId, gatewayId))
        .orderBy(asc(ports.publicPort), asc(ports.id))) as PortRow[];
    },

    async insertPort(
      input: PortInsert,
      now = new Date().toISOString(),
    ): Promise<PortRow> {
      const drizzle = await client();
      await drizzle.insert(ports).values({
        targetHost: "",
        label: "",
        source: "manual",
        sourceHostId: null,
        enabled: true,
        ...input,
        createdAt: now,
      });
      await db.persist();
      const rows = await drizzle
        .select()
        .from(ports)
        .where(eq(ports.gatewayId, input.gatewayId))
        .orderBy(desc(ports.id))
        .limit(1);
      return rows[0] as PortRow;
    },

    async updatePort(id: number, updates: PortUpdate): Promise<PortRow | null> {
      const drizzle = await client();
      await drizzle.update(ports).set(updates).where(eq(ports.id, id));
      await db.persist();
      return getPort(id);
    },

    async deletePort(id: number): Promise<void> {
      const drizzle = await client();
      await drizzle.delete(ports).where(eq(ports.id, id));
      await db.persist();
    },
  };
}
