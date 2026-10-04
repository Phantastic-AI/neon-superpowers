import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";

describe("generic owned-artifact CSV", () => {
  it("reads every row and preserves cell values without interpreting headers", () => {
    const rows = Array.from({ length: 150 }, (_, index) => `id-${index},Person ${index}, person${index}@example.com `);
    expect(parseCsv(`Registration,Display,Contact\r\n${rows.join("\r\n")}\r\n`)).toEqual({
      headers: ["Registration", "Display", "Contact"],
      rows: rows.map((row) => row.split(",")),
    });
  });

  it("handles BOM, quoted commas, escaped quotes, embedded CRLF and empty trailing cells", () => {
    expect(parseCsv('\uFEFF"Name",Notes,Email\r\n"Ada, A.","Said ""hello""\r\nagain",\r\n')).toEqual({
      headers: ["Name", "Notes", "Email"],
      rows: [["Ada, A.", 'Said "hello"\r\nagain', ""]],
    });
  });

  it("accepts a header-only table and an empty final field without a newline", () => {
    expect(parseCsv("Name,Email")).toEqual({ headers: ["Name", "Email"], rows: [] });
    expect(parseCsv("Name,Email\nAda,")).toEqual({ headers: ["Name", "Email"], rows: [["Ada", ""]] });
  });

  it("does not hide blank records or trim meaningful values", () => {
    expect(parseCsv(" Name ,Email\n Ada ,\n,\n")).toEqual({ headers: [" Name ", "Email"], rows: [[" Ada ", ""], ["", ""]] });
    expect(() => parseCsv("Name,Email\nAda,a@example.com\n\n")).toThrow(/row 3.*1.*2/i);
  });

  it.each([
    ['Name,Email\n"Ada,a@example.com', /unclosed quote/i],
    ['Name,Email\nA"da,a@example.com', /quote.*unquoted/i],
    ['Name,Email\n"Ada"oops,a@example.com', /after.*quote/i],
    ["Name,Name\nAda,Ada", /duplicate.*header/i],
    ["Name,\nAda,a@example.com", /empty.*header/i],
    ["Name,Email\nAda", /row 2.*1.*2/i],
    ["Name,Email\nAda,a@example.com,extra", /row 2.*3.*2/i],
    ["", /header/i],
  ])("rejects malformed or ambiguous tables: %s", (text, error) => {
    expect(() => parseCsv(text)).toThrow(error);
  });

  it("bounds input bytes independently of the artifact reader", () => {
    expect(() => parseCsv(`Name\n${"é".repeat(500_000)}`)).toThrow(/1,000,000|1000000/);
  });

  it("round-trips delimiter and quote combinations without repairing cells", () => {
    const cells = ["", "plain", "with,comma", 'a"b', "line\nbreak", "line\r\nbreak", " white space ", "é🐟"];
    const rows = cells.flatMap((left) => cells.map((right) => [left, right]));
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const text = ["First,Second", ...rows.map((row) => row.map(quote).join(","))].join("\r\n");
    expect(parseCsv(text)).toEqual({ headers: ["First", "Second"], rows });
  });
});
