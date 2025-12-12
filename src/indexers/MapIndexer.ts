import { OP, Script, Utils } from "@bsv/sdk";

export const MAP_PROTO = "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5";

export class MapIndexer {
  static parseMap(
    script: Script,
    mapPos: number
  ): { [key: string]: unknown } | undefined {
    if (Utils.toUTF8(script.chunks[mapPos]?.data || []) !== "SET") {
      return;
    }

    const map: { [key: string]: unknown } = {};
    for (let i = mapPos + 1; i < script.chunks.length; i += 2) {
      const chunk = script.chunks[i];
      if (
        chunk.op === OP.OP_RETURN ||
        (chunk.data?.length === 1 && chunk.data[0] !== 0x7c)
      ) {
        break;
      }

      const key = Utils.toUTF8(chunk.data || []);
      const value = Utils.toUTF8(script.chunks[i + 1]?.data || []);

      if (key === "subTypeData") {
        try {
          map[key] = JSON.parse(value);
          continue;
        } catch {
          // If JSON parsing fails, fall through to store as string
        }
      }

      map[key] = value;
    }

    return map;
  }
}
