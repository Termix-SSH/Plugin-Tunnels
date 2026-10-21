import { describe, expect, it } from "vitest";
import {
  parseHealth,
  parseProbe,
  privateInstallScript,
  privateNft,
  probeScript,
  publicInstallScript,
  publicNft,
  publicWgConf,
  teardownScript,
} from "../../src/backend/gateway/scripts.js";
import {
  DEFAULT_IGNORED_PORTS,
  parseListening,
} from "../../src/backend/gateway/scan.js";
import {
  generateWgKeyPair,
  ifaceName,
  isEndpointAddress,
  isIpv4,
  privateWgIp,
  publicWgIp,
} from "../../src/backend/gateway/wg.js";
import {
  GUEST_SCAN_SCRIPT,
  parseGuestScan,
} from "../../src/backend/gateway/guest-scan.js";
import { scrub } from "../../src/backend/gateway/service.js";

const server = generateWgKeyPair();
const client = generateWgKeyPair();

describe("wireguard keys and addresses", () => {
  it("makes 32 byte base64 keys that pair up", () => {
    expect(server.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(server.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(server.publicKey).not.toBe(client.publicKey);
  });

  it("gives each gateway its own interface and subnet", () => {
    expect(ifaceName(3)).toBe("wgtx3");
    expect(publicWgIp(3)).toBe("10.77.4.1");
    expect(privateWgIp(3)).toBe("10.77.4.2");
    expect(publicWgIp(3)).not.toBe(publicWgIp(4));
  });

  it("checks addresses", () => {
    expect(isIpv4("192.168.1.10")).toBe(true);
    expect(isIpv4("192.168.1.300")).toBe(false);
    expect(isIpv4("host.example.com")).toBe(false);
    expect(isEndpointAddress("host.example.com")).toBe(true);
    expect(isEndpointAddress("a b")).toBe(false);
    expect(isEndpointAddress("x; rm -rf /")).toBe(false);
  });
});

describe("gateway rules", () => {
  const ports = [
    {
      proto: "tcp" as const,
      publicPort: 25565,
      targetHost: "",
      targetPort: 25565,
    },
    {
      proto: "both" as const,
      publicPort: 7777,
      targetHost: "192.168.1.50",
      targetPort: 7778,
    },
  ];

  it("sends public ports to the private end or a LAN address", () => {
    const nft = publicNft(2, ports);
    expect(nft).toContain("table ip termix_gw_2");
    expect(nft).toContain(
      'iifname != "wgtx2" tcp dport 25565 dnat to 10.77.3.2:25565',
    );
    expect(nft).toContain("tcp dport 7777 dnat to 192.168.1.50:7778");
    expect(nft).toContain("udp dport 7777 dnat to 192.168.1.50:7778");
    expect(nft).toContain('oifname "wgtx2" masquerade');
  });

  it("drops the table first so reapplying never doubles rules", () => {
    const nft = publicNft(2, []);
    expect(nft.indexOf("delete table")).toBeLessThan(
      nft.indexOf("chain prerouting"),
    );
  });

  it("refuses a target that is not an address", () => {
    expect(() =>
      publicNft(2, [
        {
          proto: "tcp",
          publicPort: 80,
          targetHost: "x; reboot",
          targetPort: 80,
        },
      ]),
    ).toThrow(/Invalid target/);
  });

  it("allows the LAN targets in the public peer's allowed IPs", () => {
    const conf = publicWgConf({
      gatewayId: 2,
      listenPort: 51832,
      privateKey: server.privateKey,
      peerPublicKey: client.publicKey,
      ports,
    });
    expect(conf).toContain("ListenPort = 51832");
    expect(conf).toContain("AllowedIPs = 10.77.3.2/32, 192.168.1.50/32");
  });

  it("masquerades into the LAN on the private side", () => {
    expect(privateNft(2)).toContain(
      'iifname "wgtx2" oifname != "wgtx2" masquerade',
    );
  });

  it("refuses a malformed key", () => {
    expect(() =>
      publicWgConf({
        gatewayId: 1,
        listenPort: 51831,
        privateKey: "not a key",
        peerPublicKey: client.publicKey,
        ports: [],
      }),
    ).toThrow(/Invalid WireGuard key/);
  });

  it("writes files, a unit and a persistent start on both ends", () => {
    const pub = publicInstallScript({
      gatewayId: 2,
      listenPort: 51832,
      privateKey: server.privateKey,
      peerPublicKey: client.publicKey,
      ports,
    });
    expect(pub).toContain("/etc/wireguard/wgtx2.conf");
    expect(pub).toContain("termix-gateway-wgtx2.service");
    expect(pub).toContain("DOCKER-USER");
    expect(pub).toContain("systemctl enable --now wg-quick@wgtx2");

    const priv = privateInstallScript({
      gatewayId: 2,
      endpoint: "203.0.113.5",
      listenPort: 51832,
      privateKey: client.privateKey,
      peerPublicKey: server.publicKey,
    });
    expect(priv).toContain("Endpoint = 203.0.113.5:51832");
    expect(priv).toContain("PersistentKeepalive = 25");
    expect(priv).not.toContain("DOCKER-USER");
  });

  it("removes only what the gateway made", () => {
    const script = teardownScript(2);
    expect(script).toContain("nft delete table ip termix_gw_2");
    expect(script).toContain("/etc/wireguard/wgtx2.conf");
    expect(script).not.toContain("wgtx1");
  });
});

describe("gateway health", () => {
  it("reads the health lines", () => {
    expect(
      parseHealth("iface=1\nhandshake=1700000000\nrules=3\nnow=1700000100\n"),
    ).toEqual({
      iface: true,
      handshake: 1700000000,
      rules: 3,
      now: 1700000100,
    });
    expect(parseHealth("iface=0\nhandshake=\nrules=0\nnow=5\n")).toEqual({
      iface: false,
      handshake: 0,
      rules: 0,
      now: 5,
    });
  });

  it("reads probe answers", () => {
    const script = probeScript([
      { id: 4, host: "10.0.0.5", port: 80 },
      { id: 9, host: "127.0.0.1", port: 25565 },
    ]);
    expect(script).toContain("/dev/tcp/10.0.0.5/80");
    expect([...parseProbe("up:4\ndown:9\nnoise\n")]).toEqual([
      [4, true],
      [9, false],
    ]);
  });

  it("refuses a probe target that is not an address", () => {
    expect(() => probeScript([{ id: 1, host: "a;b", port: 80 }])).toThrow();
  });

  it("scrubs keys out of messages", () => {
    expect(scrub(`oops ${server.privateKey} bad`)).toBe("oops [key] bad");
  });
});

describe("port scan parsing", () => {
  const output = [
    "tcp LISTEN 0 4096 0.0.0.0:25565 0.0.0.0:*",
    "tcp LISTEN 0 4096 [::]:25565 [::]:*",
    "tcp LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*",
    "tcp LISTEN 0 128 192.168.1.5:8080 0.0.0.0:*",
    "tcp LISTEN 0 128 [::1]:631 [::]:*",
    "udp UNCONN 0 0 0.0.0.0:19132 0.0.0.0:*",
    "udp UNCONN 0 0 10.77.2.2:51830 0.0.0.0:*",
    "tcp ESTAB 0 0 192.168.1.5:22 192.168.1.9:5555",
  ].join("\n");

  it("keeps ports another machine can reach", () => {
    expect(parseListening(output, ["10.77.2.2"])).toEqual([
      { proto: "tcp", address: "192.168.1.5", port: 8080 },
      { proto: "udp", address: "", port: 19132 },
      { proto: "tcp", address: "", port: 25565 },
    ]);
  });

  it("skips the usual system ports by default", () => {
    expect(DEFAULT_IGNORED_PORTS).toContain(22);
    expect(DEFAULT_IGNORED_PORTS).toContain(53);
  });
});

describe("proxmox guest scan", () => {
  it("reads each guest's ports and skips system ports", () => {
    const out = [
      "@@192.168.1.20",
      "tcp LISTEN 0 128 0.0.0.0:25565 0.0.0.0:*",
      "tcp LISTEN 0 128 0.0.0.0:80 0.0.0.0:*",
      "@@192.168.1.21",
      "udp UNCONN 0 0 0.0.0.0:19132 0.0.0.0:*",
    ].join("\n");
    expect(parseGuestScan(out)).toEqual([
      {
        ip: "192.168.1.20",
        ports: [{ proto: "tcp", address: "", port: 25565 }],
      },
      {
        ip: "192.168.1.21",
        ports: [{ proto: "udp", address: "", port: 19132 }],
      },
    ]);
  });

  it("only touches qm and pct", () => {
    expect(GUEST_SCAN_SCRIPT).toContain("qm guest exec");
    expect(GUEST_SCAN_SCRIPT).toContain("pct exec");
    expect(GUEST_SCAN_SCRIPT).toContain("exit 0");
  });
});
