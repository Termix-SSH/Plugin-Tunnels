import { describe, expect, it } from "vitest";
import { findHostByTunnelEndpoint } from "../../src/backend/utils.js";

const hosts = [
  { id: 1, name: "db", ip: "10.0.0.5", username: "pg" },
  { id: 2, name: "web", ip: "10.0.0.6", username: "root" },
];

describe("findHostByTunnelEndpoint", () => {
  it("matches by id, name or address by default", () => {
    expect(findHostByTunnelEndpoint(hosts, "db")?.id).toBe(1);
    expect(findHostByTunnelEndpoint(hosts, "2")?.id).toBe(2);
    expect(findHostByTunnelEndpoint(hosts, "10.0.0.5")?.id).toBe(1);
    expect(findHostByTunnelEndpoint(hosts, "root@10.0.0.6")?.id).toBe(2);
  });

  it("leaves a plain address alone when address matching is off", () => {
    const options = { byAddress: false };
    expect(
      findHostByTunnelEndpoint(hosts, "10.0.0.5", options),
    ).toBeUndefined();
    expect(findHostByTunnelEndpoint(hosts, "db", options)?.id).toBe(1);
  });
});
