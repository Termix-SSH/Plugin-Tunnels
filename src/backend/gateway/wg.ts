import { generateKeyPairSync } from "node:crypto";

export interface WgKeyPair {
  publicKey: string;
  privateKey: string;
}

/** A WireGuard key pair: raw x25519 keys, base64. */
export function generateWgKeyPair(): WgKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  // The raw key is the last 32 bytes of the DER encoding.
  const raw = (der: Buffer) => der.subarray(der.length - 32).toString("base64");
  return {
    publicKey: raw(publicKey.export({ type: "spki", format: "der" })),
    privateKey: raw(privateKey.export({ type: "pkcs8", format: "der" })),
  };
}

export const DEFAULT_LISTEN_PORT = 51830;

/** The interface name on both ends, short enough for the 15 character limit. */
export function ifaceName(gatewayId: number): string {
  return `wgtx${gatewayId}`;
}

/** The address of the public end of the tunnel. */
export function publicWgIp(gatewayId: number): string {
  return `10.77.${(gatewayId % 250) + 1}.1`;
}

/** The address of the private end of the tunnel. */
export function privateWgIp(gatewayId: number): string {
  return `10.77.${(gatewayId % 250) + 1}.2`;
}

export function defaultListenPort(gatewayId: number): number {
  return DEFAULT_LISTEN_PORT + (gatewayId % 100);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** An address the private host can dial: an IPv4 address or a DNS name. */
export function isEndpointAddress(value: string): boolean {
  return isIpv4(value) || HOSTNAME.test(value);
}
