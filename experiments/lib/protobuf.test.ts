import { describe, expect, it } from "vitest";

import {
  concat,
  doubleField,
  findField,
  int32Field,
  messageField,
  stringField,
  varint,
} from "./protobuf.js";

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("protobuf writer", () => {
  it("encodes single-byte and multi-byte varints", () => {
    expect(hex(varint(0))).toBe("00");
    expect(hex(varint(127))).toBe("7f");
    expect(hex(varint(128))).toBe("8001");
    expect(hex(varint(300))).toBe("ac02");
  });

  it("encodes a length-delimited string field", () => {
    // field 2, wire type 2 => tag 0x12; length 3; "abc"
    expect(hex(stringField(2, "abc"))).toBe("12" + "03" + "616263");
  });

  it("encodes a varint field", () => {
    // field 4, wire type 0 => tag 0x20; value 0
    expect(hex(int32Field(4, 0))).toBe("2000");
  });

  it("nests a message under a field", () => {
    // field 1 tag 0x0a; inner length 3; inner field 1 tag 0x0a; length 1; "x"
    expect(hex(messageField(1, stringField(1, "x")))).toBe("0a" + "03" + "0a" + "01" + "78");
  });

  it("concatenates in order", () => {
    expect(hex(concat([varint(1), varint(2)]))).toBe("0102");
  });
});

describe("protobuf reader", () => {
  it("round-trips a nested string through the writer", () => {
    const inner = stringField(9, "recipe-data-id");
    const outer = messageField(3, inner);

    const nested = findField(outer, 3);
    expect(nested).not.toBeNull();

    const leaf = findField(nested as Uint8Array, 9);
    expect(new TextDecoder().decode(leaf as Uint8Array)).toBe("recipe-data-id");
  });

  it("skips over fields it was not asked for", () => {
    const message = concat([stringField(1, "a"), int32Field(2, 300), stringField(3, "b")]);

    expect(new TextDecoder().decode(findField(message, 3) as Uint8Array)).toBe("b");
  });

  it("returns null for an absent field", () => {
    expect(findField(stringField(1, "a"), 7)).toBeNull();
  });
});

describe("doubleField", () => {
  it("writes a little-endian float64 with a wire-type-1 tag", () => {
    const encoded = doubleField(2, 1.5);

    expect(encoded[0]).toBe((2 << 3) | 1);
    expect(new DataView(encoded.slice(1).buffer).getFloat64(0, true)).toBe(1.5);
  });
});
