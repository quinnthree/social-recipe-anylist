/**
 * A minimal protobuf writer, enough to hand-build one AnyList operation.
 *
 * This exists only so an experiment can send a *different* payload than the
 * NAPI library sends, to work out which shape the AnyList server actually
 * accepts. It is research scaffolding, not a second protocol implementation,
 * and nothing in `src/` depends on it.
 */

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

export function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;

  do {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    bytes.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);

  return Uint8Array.from(bytes);
}

function tag(field: number, wireType: number): Uint8Array {
  return varint((field << 3) | wireType);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

export function stringField(field: number, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  return concat([tag(field, WIRE_LENGTH_DELIMITED), varint(encoded.length), encoded]);
}

export function messageField(field: number, value: Uint8Array): Uint8Array {
  return concat([tag(field, WIRE_LENGTH_DELIMITED), varint(value.length), value]);
}

export function int32Field(field: number, value: number): Uint8Array {
  return concat([tag(field, WIRE_VARINT), varint(value)]);
}

/** AnyList carries its sync timestamps as protobuf doubles (wire type 1). */
export function doubleField(field: number, value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return concat([tag(field, 1), bytes]);
}

export interface ProtoField {
  field: number;
  wireType: number;
  /** Present for length-delimited fields (wire type 2). */
  bytes?: Uint8Array;
  /** Present for varint fields (wire type 0). */
  value?: number;
}

/**
 * A tolerant reader: it walks the wire format without a schema, which is all
 * an experiment needs to reach one nested field in a large response.
 * Unsupported wire types stop the scan rather than guess.
 */
export function readMessage(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (key === null) break;

    const field = key.value >>> 3;
    const wireType = key.value & 0x07;
    offset = key.offset;

    if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(bytes, offset);
      if (length === null) break;
      const end = length.offset + length.value;
      if (end > bytes.length) break;
      fields.push({ field, wireType, bytes: bytes.subarray(length.offset, end) });
      offset = end;
    } else if (wireType === WIRE_VARINT) {
      const value = readVarint(bytes, offset);
      if (value === null) break;
      fields.push({ field, wireType, value: value.value });
      offset = value.offset;
    } else if (wireType === 1) {
      offset += 8; // 64-bit
    } else if (wireType === 5) {
      offset += 4; // 32-bit
    } else {
      break; // groups and anything unknown: stop rather than misread
    }
  }

  return fields;
}

/** Returns the bytes of the first length-delimited occurrence of `field`. */
export function findField(bytes: Uint8Array, field: number): Uint8Array | null {
  return readMessage(bytes).find((entry) => entry.field === field)?.bytes ?? null;
}

function readVarint(
  bytes: Uint8Array,
  start: number,
): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  let offset = start;

  while (offset < bytes.length) {
    const byte = bytes[offset] as number;
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
    if (shift > 49) return null;
  }

  return null;
}
