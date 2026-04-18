import { describe, expect, it } from "vitest";

import { encodeBmp32, estimateBmp32Size, fitDimensionsToMaxBytes } from "./bmp";

describe("estimateBmp32Size", () => {
  it("returns the expected size for a 1x1 image", () => {
    expect(estimateBmp32Size(1, 1)).toBe(126);
  });

  it("includes the fixed header and four bytes per pixel", () => {
    expect(estimateBmp32Size(20, 10)).toBe(14 + 108 + 20 * 10 * 4);
  });
});

describe("fitDimensionsToMaxBytes", () => {
  it("keeps dimensions when already within the limit", () => {
    expect(fitDimensionsToMaxBytes(200, 100, estimateBmp32Size(200, 100))).toEqual({
      width: 200,
      height: 100,
      scaled: false,
    });
  });

  it("reduces dimensions when the bitmap would be too large", () => {
    const next = fitDimensionsToMaxBytes(5000, 3000, 10 * 1024 * 1024);

    expect(next.scaled).toBe(true);
    expect(next.width).toBeLessThan(5000);
    expect(next.height).toBeLessThan(3000);
    expect(estimateBmp32Size(next.width, next.height)).toBeLessThanOrEqual(10 * 1024 * 1024);
  });
});

describe("encodeBmp32", () => {
  it("writes a BMP header and BGRA pixel data", async () => {
    const blob = encodeBmp32({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 128, 64, 32]),
    } as unknown as ImageData);

    expect(blob.size).toBe(126);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes[0]).toBe(0x42);
    expect(bytes[1]).toBe(0x4d);
    expect(bytes[14]).toBe(108);
    expect(Array.from(bytes.slice(122, 126))).toEqual([64, 128, 255, 32]);
  });
});
