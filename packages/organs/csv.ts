// CSV is transport, not interpretation: preserve every field, then let the
// caller map observed headers to its domain. Nothing here knows a platform.

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

const MAX_CSV_BYTES = 1_000_000;

export function parseCsv(text: string): CsvTable {
  if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES) {
    throw new Error(`CSV exceeds the ${MAX_CSV_BYTES} byte artifact limit.`);
  }
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let state: "plain" | "quoted" | "closed" = "plain";
  let started = false;
  const endField = () => {
    record.push(field);
    field = "";
    state = "plain";
    started = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === "quoted") {
      if (character !== '"') field += character;
      else if (text[index + 1] === '"') { field += '"'; index += 1; }
      else state = "closed";
      continue;
    }
    if (character === ",") { endField(); continue; }
    if (character === "\r" || character === "\n") {
      endRecord();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      continue;
    }
    if (state === "closed") throw new Error(`CSV row ${records.length + 1} has text after a closing quote.`);
    if (character === '"') {
      if (started) throw new Error(`CSV row ${records.length + 1} has a quote inside an unquoted field.`);
      state = "quoted";
    } else field += character;
    started = true;
  }
  if (state === "quoted") throw new Error(`CSV row ${records.length + 1} has an unclosed quote.`);
  if (started || record.length > 0) endRecord();
  const [headers, ...rows] = records;
  if (!headers) throw new Error("CSV needs a header row.");
  if (headers.some((header) => header === "")) throw new Error("CSV has an empty header.");
  if (new Set(headers).size !== headers.length) throw new Error("CSV has duplicate headers; column mapping would be ambiguous.");
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].length !== headers.length) {
      throw new Error(`CSV row ${index + 2} has ${rows[index].length} fields; expected ${headers.length}.`);
    }
  }
  return { headers, rows };
}
