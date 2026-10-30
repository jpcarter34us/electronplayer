// DMAP, the binary format of DAAP (iTunes sharing) responses: each element
// is a 4-character tag, a 32-bit big-endian length, and the value. Values
// are either containers (more elements) or leaves (integers, strings,
// dates, versions). The format does not say which a tag is, so containers
// are listed here; everything else is a leaf, read by the caller as the
// type it expects.

const CONTAINERS = new Set([
  'msrv', 'mccr', 'mdcl', 'mlog', 'mupd', 'avdb', 'adbs', 'aply', 'apso', 'mlcl', 'mlit',
  'mshl', 'mlsh', 'abro', 'abar', 'abal', 'abcp', 'abgn', 'agal', 'agar', 'arsv', 'arif',
  'prsv', 'msml', 'casp', 'cmst', 'mdbk', 'ated',
]);

export class DmapNode {
  constructor(readonly tag: string, private value: Buffer | DmapNode[]) {}

  get children(): DmapNode[] {
    return Array.isArray(this.value) ? this.value : [];
  }

  /** First child with this tag (searching only direct children). */
  get(tag: string): DmapNode | undefined {
    return this.children.find((c) => c.tag === tag);
  }

  /** Every direct child with this tag. */
  all(tag: string): DmapNode[] {
    return this.children.filter((c) => c.tag === tag);
  }

  /** Follows a path of tags: node.at('mlcl', 'mlit'). */
  at(...tags: string[]): DmapNode | undefined {
    let node: DmapNode | undefined = this;
    for (const tag of tags) node = node?.get(tag);
    return node;
  }

  /** The leaf as an unsigned big-endian integer (1, 2, 4 or 8 bytes). */
  get int(): number {
    const b = Array.isArray(this.value) ? Buffer.alloc(0) : this.value;
    switch (b.length) {
      case 1: return b.readUInt8(0);
      case 2: return b.readUInt16BE(0);
      case 4: return b.readUInt32BE(0);
      case 8: return Number(b.readBigUInt64BE(0));
      default: return 0;
    }
  }

  /** The leaf as UTF-8 text. */
  get str(): string {
    return Array.isArray(this.value) ? '' : this.value.toString('utf8');
  }

  num(tag: string): number | undefined {
    const n = this.get(tag);
    return n ? n.int : undefined;
  }

  text(tag: string): string | undefined {
    const n = this.get(tag);
    return n ? n.str : undefined;
  }
}

function parseList(buf: Buffer, start: number, end: number, depth: number): DmapNode[] {
  if (depth > 16) throw new Error('DMAP nesting too deep');
  const nodes: DmapNode[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const tag = buf.toString('latin1', pos, pos + 4);
    const length = buf.readUInt32BE(pos + 4);
    const from = pos + 8;
    const to = from + length;
    if (to > end) throw new Error(`Truncated DMAP element ${tag}`);
    nodes.push(new DmapNode(tag, CONTAINERS.has(tag) ? parseList(buf, from, to, depth + 1) : buf.subarray(from, to)));
    pos = to;
  }
  return nodes;
}

/** Parses a response body; its top element (msrv, mlog, adbs, ...) is returned. */
export function parseDmap(buf: Buffer): DmapNode {
  const [top] = parseList(buf, 0, buf.length, 0);
  if (!top) throw new Error('Empty DAAP response');
  return top;
}
