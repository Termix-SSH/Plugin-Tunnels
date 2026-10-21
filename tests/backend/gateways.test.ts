import { afterEach, describe, expect, it } from "vitest";
import { host, startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

interface Call {
  hostId: number;
  command: string;
  stdin?: string;
}

interface Fake {
  calls: Call[];
  /** What `ss` prints per host. */
  listening: Record<number, string>;
  /** What the health script prints per host. */
  health: Record<number, string>;
  probe: string;
  applied: () => Call[];
}

const PRIVATE = 7;
const PUBLIC = 8;

/** Plays both hosts: answers the preflight, scripts, health and ss reads. */
function fakeSsh(started: TestServer): Fake {
  const fake: Fake = {
    calls: [],
    listening: { [PRIVATE]: "", [PUBLIC]: "" },
    health: {},
    probe: "",
    applied: () => fake.calls.filter((c) => c.stdin?.includes("TX_APPLIED")),
  };
  const ok = (stdout: string) => ({
    stdout,
    stderr: "",
    code: 0,
    truncated: false,
    timedOut: false,
  });
  Object.assign(started.mock.ctx.ssh, {
    exec: async (
      hostId: number,
      command: string,
      options?: { stdin?: string },
    ) => {
      fake.calls.push({ hostId, command, stdin: options?.stdin });
      const script = options?.stdin;
      if (script === undefined) {
        if (command.includes("ss -H")) return ok(fake.listening[hostId] ?? "");
        return ok("root=1\nwg=1\nnft=1\nsystemd=1\npm=apt\n");
      }
      if (script.includes("TX_APPLIED")) return ok("TX_APPLIED\n");
      if (script.includes("TX_REMOVED")) return ok("TX_REMOVED\n");
      if (script.includes("iface=")) return ok(fake.health[hostId] ?? "");
      if (script.includes("/dev/tcp")) return ok(fake.probe);
      return ok("");
    },
  });
  return fake;
}

async function start() {
  const started = await startServer({
    hosts: {
      "user-1": [
        host({ id: PRIVATE, name: "zeus", ip: "192.168.1.5" }),
        host({ id: PUBLIC, name: "hades", ip: "100.74.9.35" }),
      ],
      "user-2": [],
    },
  });
  started.db.sqlite.exec(
    `INSERT INTO ssh_data (id) VALUES (${PRIVATE}), (${PUBLIC})`,
  );
  return { started, fake: fakeSsh(started) };
}

const createBody = {
  name: "Home",
  privateHostId: PRIVATE,
  publicHostId: PUBLIC,
  endpoint: "203.0.113.5",
};

describe("gateways", () => {
  it("sets up the public end, then the private end, with sealed keys", async () => {
    const { started, fake } = await start();
    server = started;

    const created = await started.request("POST", "/gateways", {
      body: createBody,
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      name: "Home",
      endpoint: "203.0.113.5",
      ports: [],
    });
    expect(created.body.listenPort).toBeGreaterThanOrEqual(51830);
    expect(created.body.privateKey).toBeUndefined();

    const applied = fake.applied();
    expect(applied.map((c) => c.hostId)).toEqual([PUBLIC, PRIVATE]);
    expect(applied[0].stdin).toContain("ListenPort =");
    expect(applied[1].stdin).toContain("Endpoint = 203.0.113.5:");

    // Only sealed keys sit in the table.
    const row = started.db.sqlite
      .prepare("SELECT private_key, peer_private_key FROM p_tunnels_gateways")
      .get() as { private_key: string; peer_private_key: string };
    expect(applied[0].stdin).not.toContain(row.private_key);
    expect(row.private_key).not.toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("refuses a host without root or sudo", async () => {
    const { started } = await start();
    server = started;
    Object.assign(started.mock.ctx.ssh, {
      exec: async () => ({
        stdout: "root=0\nwg=1\nnft=1\nsystemd=1\npm=apt\n",
        stderr: "",
        code: 0,
        truncated: false,
        timedOut: false,
      }),
    });

    const created = await started.request("POST", "/gateways", {
      body: createBody,
    });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe("sudo");
    expect((await started.request("GET", "/gateways")).body).toEqual([]);
  });

  it("keeps gateways private to their owner", async () => {
    const { started } = await start();
    server = started;
    const created = await started.request("POST", "/gateways", {
      body: createBody,
    });

    expect(
      (await started.request("GET", "/gateways", { user: "user-2" })).body,
    ).toEqual([]);
    const other = await started.request("GET", `/gateways/${created.body.id}`, {
      user: "user-2",
    });
    expect(other.status).toBe(404);
  });

  it("adds a port and rewrites the rules, once", async () => {
    const { started, fake } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    fake.calls.length = 0;

    const added = await started.request(
      "POST",
      `/gateways/${gateway.id}/ports`,
      { body: { proto: "tcp", publicPort: 25565, targetPort: 25565 } },
    );
    expect(added.status).toBe(200);
    const publicApply = fake.applied().find((c) => c.hostId === PUBLIC);
    expect(publicApply?.stdin).toContain("tcp dport 25565 dnat to");

    const twice = await started.request(
      "POST",
      `/gateways/${gateway.id}/ports`,
      { body: { proto: "both", publicPort: 25565, targetPort: 1 } },
    );
    expect(twice.status).toBe(409);
  });

  it("warns when the public host already listens, unless forced", async () => {
    const { started, fake } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    fake.listening[PUBLIC] = "tcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\n";

    const path = `/gateways/${gateway.id}/ports`;
    const busy = await started.request("POST", path, {
      body: { proto: "tcp", publicPort: 443, targetPort: 443 },
    });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("conflict");

    const forced = await started.request("POST", path, {
      body: { proto: "tcp", publicPort: 443, targetPort: 443, force: true },
    });
    expect(forced.status).toBe(200);
  });

  it("only takes IPv4 addresses as targets", async () => {
    const { started } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    const bad = await started.request("POST", `/gateways/${gateway.id}/ports`, {
      body: {
        proto: "tcp",
        publicPort: 80,
        targetPort: 80,
        targetHost: "x; reboot",
      },
    });
    expect(bad.status).toBe(400);
  });

  it("turns a port off by rewriting the rules without it", async () => {
    const { started, fake } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    const port = (
      await started.request("POST", `/gateways/${gateway.id}/ports`, {
        body: { proto: "udp", publicPort: 19132, targetPort: 19132 },
      })
    ).body;
    fake.calls.length = 0;

    const off = await started.request(
      "PATCH",
      `/gateways/${gateway.id}/ports/${port.id}`,
      { body: { enabled: false } },
    );
    expect(off.body.enabled).toBe(false);
    const publicApply = fake.applied().find((c) => c.hostId === PUBLIC);
    expect(publicApply?.stdin).not.toContain("dport 19132");
  });

  it("reports the state and applies again when rules went missing", async () => {
    const { started, fake } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    await started.request("POST", `/gateways/${gateway.id}/ports`, {
      body: { proto: "tcp", publicPort: 25565, targetPort: 25565 },
    });

    const now = 1_700_000_000;
    const healthy = `iface=1\nhandshake=${now - 20}\nrules=1\nnow=${now}\n`;
    fake.health = { [PUBLIC]: healthy, [PRIVATE]: healthy };
    fake.probe = `up:1\n`;
    const up = await started.request("POST", `/gateways/${gateway.id}/check`);
    expect(up.body.status.state).toBe("up");
    expect(up.body.status.handshakeAge).toBe(20);

    fake.health[PUBLIC] =
      `iface=1\nhandshake=${now - 20}\nrules=0\nnow=${now}\n`;
    const missing = await started.request(
      "POST",
      `/gateways/${gateway.id}/check`,
    );
    expect(missing.body.status.state).toBe("rules_missing");
  });

  it("reports an unreachable host", async () => {
    const { started } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    Object.assign(started.mock.ctx.ssh, {
      exec: async () => {
        throw new Error("connect ETIMEDOUT");
      },
    });
    const checked = await started.request(
      "POST",
      `/gateways/${gateway.id}/check`,
    );
    expect(checked.body.status.state).toBe("unreachable");
    expect(checked.body.status.message).toContain("Public host");
  });

  it("lists scanned ports switched off, and on when asked", async () => {
    const { started, fake } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    fake.listening[PRIVATE] = [
      "tcp LISTEN 0 4096 0.0.0.0:25565 0.0.0.0:*",
      "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
      "tcp LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*",
    ].join("\n");

    const scan = await started.request("POST", `/gateways/${gateway.id}/scan`);
    expect(scan.body.found).toBe(1);
    const listed = (await started.request("GET", `/gateways/${gateway.id}`))
      .body;
    expect(listed.ports).toHaveLength(1);
    expect(listed.ports[0]).toMatchObject({
      publicPort: 25565,
      source: "scan",
      enabled: false,
    });

    // Nothing new the second time.
    expect(
      (await started.request("POST", `/gateways/${gateway.id}/scan`)).body
        .found,
    ).toBe(0);

    fake.listening[PRIVATE] += "\nudp UNCONN 0 0 0.0.0.0:19132 0.0.0.0:*";
    await started.request("PATCH", `/gateways/${gateway.id}`, {
      body: { autoEnable: true },
    });
    fake.calls.length = 0;
    await started.request("POST", `/gateways/${gateway.id}/scan`);
    const after = (await started.request("GET", `/gateways/${gateway.id}`))
      .body;
    const added = after.ports.find(
      (p: { publicPort: number }) => p.publicPort === 19132,
    );
    expect(added.enabled).toBe(true);
    expect(fake.applied().length).toBe(2);
  });

  it("does not forward a scanned port the public host already uses", async () => {
    const { started, fake } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    await started.request("PATCH", `/gateways/${gateway.id}`, {
      body: { autoEnable: true },
    });
    fake.listening[PRIVATE] = "tcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*";
    fake.listening[PUBLIC] = "tcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*";

    await started.request("POST", `/gateways/${gateway.id}/scan`);
    const listed = (await started.request("GET", `/gateways/${gateway.id}`))
      .body;
    expect(listed.ports[0]).toMatchObject({ publicPort: 443, enabled: false });
  });

  it("takes everything off both hosts when removed", async () => {
    const { started, fake } = await start();
    server = started;
    const gateway = (
      await started.request("POST", "/gateways", { body: createBody })
    ).body;
    fake.calls.length = 0;

    const removed = await started.request("DELETE", `/gateways/${gateway.id}`);
    expect(removed.status).toBe(200);
    const teardowns = fake.calls.filter((c) => c.stdin?.includes("TX_REMOVED"));
    expect(teardowns.map((c) => c.hostId).sort()).toEqual([PRIVATE, PUBLIC]);
    expect((await started.request("GET", "/gateways")).body).toEqual([]);
  });
});
