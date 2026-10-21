import {
  adoptLegacyTable,
  boolean,
  defineTable,
  id,
  integer,
  refHost,
  refUser,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

/**
 * Client tunnel presets the desktop app saves per user.
 *
 * Adopted from core's c2s_tunnel_presets, so the column names are the legacy
 * ones and the rename carries every existing row across. Core never indexed
 * it, so there is no legacy index to keep.
 */
export const presets = adoptLegacyTable(
  "c2s_tunnel_presets",
  defineTable("presets", {
    id: id(),
    userId: refUser(),
    name: text().notNull(),
    // JSON: TunnelConnection[]
    config: text().notNull(),
    platform: text(),
    computerName: text(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  }),
);

/** A host's saved server tunnels. One row per host, the list is JSON. */
export const sshTunnels = defineTable(
  "ssh",
  {
    id: id(),
    userId: refUser(),
    hostId: refHost(),
    // JSON: TunnelConnection[]
    connections: text().notNull(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  { uniques: [{ name: "tunnels_ssh_host_unique", columns: ["hostId"] }] },
);

/**
 * A WireGuard gateway: a private host dials a public host, and public ports
 * on the public host are forwarded back to services on the private side.
 * Keys are sealed with ctx.secrets.
 */
export const gateways = defineTable("gateways", {
  id: id(),
  userId: refUser(),
  name: varchar(120).notNull(),
  privateHostId: integer().notNull(),
  publicHostId: integer().notNull(),
  // Address the private host dials, host or ip.
  endpoint: varchar(255).notNull(),
  listenPort: integer().notNull(),
  publicKey: varchar(64).notNull(),
  privateKey: text().notNull(),
  peerPublicKey: varchar(64).notNull(),
  peerPrivateKey: text().notNull(),
  scanEnabled: boolean().notNull().default(false),
  scanInterval: integer().notNull().default(10),
  autoEnable: boolean().notNull().default(false),
  // Proxmox nodes: also look inside running VMs and containers
  scanGuests: boolean().notNull().default(true),
  // JSON: number[] of extra hosts to scan for ports
  sourceHostIds: text().notNull().default("[]"),
  // JSON: number[] of ports the scan skips
  ignoredPorts: text().notNull().default("[]"),
  createdAt: timestamp().notNull().defaultNow(),
  updatedAt: timestamp().notNull().defaultNow(),
});

export const gatewayPorts = defineTable(
  "gateway_ports",
  {
    id: id(),
    gatewayId: integer().notNull(),
    // tcp, udp or both
    proto: varchar(8).notNull(),
    publicPort: integer().notNull(),
    // Empty means a service on the private host itself.
    targetHost: varchar(255).notNull().default(""),
    targetPort: integer().notNull(),
    label: varchar(120).notNull().default(""),
    // manual or scan
    source: varchar(8).notNull().default("manual"),
    sourceHostId: integer(),
    enabled: boolean().notNull().default(true),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      { name: "tunnels_gateway_ports_gateway", columns: ["gatewayId"] },
    ],
  },
);

export const tables = [presets, sshTunnels, gateways, gatewayPorts];
