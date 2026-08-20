const META_TAG = /<meta\b[^>]*>/gi;
const ATTRIBUTE = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1];
    if (name === undefined) continue;
    attributes.set(name.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/**
 * Reads the `content` of the first `<meta>` tag whose `property` or `name`
 * matches `key`. Returns null when the tag is absent or its content is empty.
 */
export function readMetaContent(html: string, key: string): string | null {
  const wanted = key.toLowerCase();
  for (const match of html.matchAll(META_TAG)) {
    const tag = match[0];
    const attributes = attributesOf(tag);
    const identifier = attributes.get("property") ?? attributes.get("name");
    if (identifier?.toLowerCase() !== wanted) continue;

    const content = attributes.get("content");
    if (content === undefined) continue;

    const decoded = decodeHtmlEntities(content).trim();
    if (decoded.length > 0) return decoded;
  }
  return null;
}
