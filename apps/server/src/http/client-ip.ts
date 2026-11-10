import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';
import type { Config } from '../config/types.ts';

/** Reported when the request did not come through a socket (in-process test requests). */
const UNKNOWN = 'unknown';

/** `::ffff:10.0.0.5` (an IPv4 client on a dual-stack socket) becomes `10.0.0.5`. */
function unmapIpv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
}

function socketAddress(c: Context): string {
  // The Node adapter passes the incoming message as `c.env.incoming`.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const address = env?.incoming?.socket?.remoteAddress;
  return address ? unmapIpv4(address) : UNKNOWN;
}

function familyOf(address: string): 'ipv4' | 'ipv6' | null {
  const family = isIP(address);
  return family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
}

/** The parsed form of a `PINWALL_TRUST_PROXY` list; the config keeps the same array for life. */
const trustedRanges = new WeakMap<string[], BlockList>();

function rangesOf(entries: string[]): BlockList {
  let list = trustedRanges.get(entries);
  if (!list) {
    list = new BlockList();
    for (const entry of entries) {
      const [address = '', prefix] = entry.split('/');
      const family = familyOf(address);
      if (family === null) continue; // loadConfig already rejects these
      if (prefix === undefined) list.addAddress(address, family);
      else list.addSubnet(address, Number(prefix), family);
    }
    trustedRanges.set(entries, list);
  }
  return list;
}

/**
 * The address of the client that sent the request. Without `PINWALL_TRUST_PROXY` it is the
 * socket's peer and `X-Forwarded-For` is ignored. Proxies append the address they received the
 * request from, so only the right end of the header can be believed:
 * - `true` means exactly one trusted proxy (the peer), so the client is the right-most entry;
 * - with a list, the peer must be in it, and the header is read right to left, skipping trusted
 *   proxies: the first address outside the list is the client.
 * Entries to the left of the client are whatever the client wrote and are never used. An entry
 * that is not an IP address ends the walk, and the last hop before it is the client.
 */
export function clientIp(c: Context, trustProxy: Config['trustProxy']): string {
  const peer = socketAddress(c);
  if (trustProxy === false) return peer;

  const hops = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => unmapIpv4(hop.trim()))
    .filter((hop) => hop.length > 0);

  if (trustProxy === true) {
    const last = hops.at(-1);
    return last !== undefined && familyOf(last) !== null ? last : peer;
  }

  const ranges = rangesOf(trustProxy);
  const isTrusted = (address: string): boolean => {
    const family = familyOf(address);
    return family !== null && ranges.check(address, family);
  };
  if (!isTrusted(peer)) return peer;

  let client = peer;
  for (const hop of hops.reverse()) {
    if (familyOf(hop) === null) break;
    client = hop;
    if (!isTrusted(hop)) break;
  }
  return client;
}
