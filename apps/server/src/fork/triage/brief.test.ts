import { describe, expect, test } from "vite-plus/test";

import { excerptDiff } from "./brief.ts";

const section = (path: string, size: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${"+x\n".repeat(size / 3)}`;

describe("excerptDiff", () => {
  test("keeps a diff under the budget whole", () => {
    const diff = section("src/a.ts", 300);
    expect(excerptDiff(diff, [])).toEqual({ text: diff, basis: "full diff", omitted: [] });
  });

  test("prioritizes source, names lockfiles, clips large files, and keeps small tests", () => {
    const diff = [
      section("src/a.test.ts", 3_000),
      section("bun.lock", 30_000),
      section("src/huge.ts", 30_000),
      section("src/b.ts", 3_000),
      ...Array.from({ length: 10 }, (_, i) => section(`src/more${i}.ts`, 6_000)),
    ].join("");
    const result = excerptDiff(diff, ["src/a.test.ts"]);
    expect(result.basis).toBe("diff excerpt");
    expect(result.text.length).toBeLessThanOrEqual(40_000);
    expect(result.text.startsWith("diff --git a/src/huge.ts")).toBe(true);
    expect(result.text).toContain("more lines of this file cut");
    expect(result.text).not.toContain("b/bun.lock");
    expect(result.omitted).toEqual([
      "src/more4.ts",
      "src/more5.ts",
      "src/more6.ts",
      "src/more7.ts",
      "src/more8.ts",
      "src/more9.ts",
      "bun.lock",
    ]);
    expect(result.text.indexOf("a/src/a.test.ts")).toBeGreaterThan(
      result.text.indexOf("a/src/more3.ts"),
    );
  });
});
