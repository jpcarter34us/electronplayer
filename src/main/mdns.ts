import dgram from 'node:dgram';
import os from 'node:os';

// Finds services on the local network with multicast DNS (RFC 6762), for
// DAAP shares (_daap._tcp). The query is sent from an ordinary port, which
// makes it a "legacy unicast" query (section 6.7): responders (macOS
// mDNSResponder, Avahi, ...) answer this socket directly, so nothing needs
// to bind port 5353 next to the system's own responder. The query goes out
// on every IPv4 interface and is repeated, since one multicast packet is
// easily missed.

export interface MdnsService {
  /** Instance name, e.g. "Jane's Library". */
  name: string;
  host: string;
  address?: string;
  port: number;
  txt: Record<string, string>;
}

const MDNS = { address: '224.0.0.251', port: 5353 };
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

interface Record_ {
  name: string;
  type: number;
  data: Buffer;
  /** Offset of data in the whole message (for compressed names inside it). */
  at: number;
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean).map((label) => {
    const b = Buffer.from(label, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function query(questions: [string, number][]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(questions.length, 4);
  return Buffer.concat([header, ...questions.map(([name, type]) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2); // IN
    return Buffer.concat([encodeName(name), tail]);
  })]);
}

/** Reads a (possibly compressed) name at `pos`; returns it and the position after it. */
function readName(msg: Buffer, pos: number): [string, number] {
  const labels: string[] = [];
  let end = -1;
  for (let jumps = 0; jumps < 32; jumps++) {
    const len = msg[pos];
    if (len === undefined) break;
    if (len === 0) {
      pos++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | msg[pos + 1];
      continue;
    }
    labels.push(msg.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join('.'), end >= 0 ? end : pos];
}

function parse(msg: Buffer): Record_[] {
  if (msg.length < 12) return [];
  const counts = [4, 6, 8, 10].map((o) => msg.readUInt16BE(o));
  let pos = 12;
  for (let i = 0; i < counts[0]; i++) pos = readName(msg, pos)[1] + 4; // questions
  const records: Record_[] = [];
  const total = counts[1] + counts[2] + counts[3];
  for (let i = 0; i < total && pos + 10 <= msg.length; i++) {
    const [name, after] = readName(msg, pos);
    const type = msg.readUInt16BE(after);
    const length = msg.readUInt16BE(after + 8);
    const at = after + 10;
    records.push({ name: name.toLowerCase(), type, data: msg.subarray(at, at + length), at });
    pos = at + length;
  }
  return records;
}

/** Browses for `type` (e.g. "_daap._tcp.local") for `timeoutMs`. */
export function browse(type: string, timeoutMs = 1500): Promise<MdnsService[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4' });
    const ptrs = new Set<string>();
    const srv = new Map<string, { host: string; port: number }>();
    const txt = new Map<string, Record<string, string>>();
    const addresses = new Map<string, string>();
    const asked = new Set<string>();
    const lower = type.toLowerCase();

    const interfaces = Object.values(os.networkInterfaces()).flat()
      .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4').map((i) => i.address);
    const send = (questions: [string, number][]) => {
      const packet = query(questions);
      for (const address of interfaces.length ? interfaces : [undefined]) {
        try {
          if (address) socket.setMulticastInterface(address);
          socket.send(packet, MDNS.port, MDNS.address);
        } catch {}
      }
    };

    socket.on('message', (msg) => {
      for (const r of parse(msg)) {
        if (r.type === TYPE.PTR && r.name === lower) ptrs.add(readName(msg, r.at)[0]);
        else if (r.type === TYPE.SRV && r.data.length >= 7) {
          srv.set(r.name, { port: r.data.readUInt16BE(4), host: readName(msg, r.at + 6)[0] });
        } else if (r.type === TYPE.TXT) {
          const entries: Record<string, string> = {};
          for (let p = 0; p < r.data.length;) {
            const len = r.data[p];
            const s = r.data.toString('utf8', p + 1, p + 1 + len);
            const eq = s.indexOf('=');
            if (s) entries[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? '' : s.slice(eq + 1);
            p += 1 + len;
          }
          txt.set(r.name, entries);
        } else if (r.type === TYPE.A && r.data.length === 4) addresses.set(r.name, [...r.data].join('.'));
      }
      // Ask for what the answer left out (responders usually include it).
      const missing: [string, number][] = [];
      for (const name of ptrs) {
        const key = name.toLowerCase();
        if (!srv.has(key) && !asked.has(`srv:${key}`)) {
          asked.add(`srv:${key}`);
          missing.push([name, TYPE.SRV], [name, TYPE.TXT]);
        }
        const host = srv.get(key)?.host.toLowerCase();
        if (host && !addresses.has(host) && !asked.has(`a:${host}`)) {
          asked.add(`a:${host}`);
          missing.push([host, TYPE.A]);
        }
      }
      if (missing.length) send(missing);
    });

    socket.on('error', () => finish());
    const repeats: NodeJS.Timeout[] = [];
    socket.bind(0, () => {
      for (const at of [0, 250, 700, Math.max(800, timeoutMs - 500)]) repeats.push(setTimeout(() => send([[type, TYPE.PTR]]), at));
    });

    let done = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      repeats.forEach(clearTimeout);
      socket.close();
      const services: MdnsService[] = [];
      for (const full of ptrs) {
        const key = full.toLowerCase();
        const s = srv.get(key);
        if (!s) continue;
        const suffix = `.${type}`;
        const name = full.toLowerCase().endsWith(suffix.toLowerCase()) ? full.slice(0, -suffix.length) : full;
        services.push({ name, host: s.host.replace(/\.$/, ''), address: addresses.get(s.host.toLowerCase()), port: s.port, txt: txt.get(key) ?? {} });
      }
      resolve(services);
    }
  });
}
