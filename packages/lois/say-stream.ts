// lois/say-stream — stream the `"say"` string value out of the model's JSON as
// it arrives (the latency law: first words on screen while the rest of the
// turn is still being written). Mechanical scanning, no parsing gamble: emits
// nothing until `"say"` opens, unescapes as it goes, stops at the closing
// quote. The one hand-rolled bit that deliberately survived the SDK refactor.

export function sayScanner(emit: (text: string) => void): (chunk: string) => void {
  let buf = "";
  let inSay = false;
  let done = false;
  let esc = false;
  return (chunk: string) => {
    if (done) return;
    if (!inSay) {
      buf += chunk;
      const m = buf.match(/"say"\s*:\s*"/);
      if (!m || m.index === undefined) {
        buf = buf.slice(-24); // keep a tail in case the key spans chunks
        return;
      }
      inSay = true;
      chunk = buf.slice(m.index + m[0].length);
      buf = "";
    }
    let out = "";
    for (const ch of chunk) {
      if (esc) {
        out += ch === "n" ? "\n" : ch === "t" ? "\t" : ch;
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        done = true;
        break;
      } else {
        out += ch;
      }
    }
    if (out) emit(out);
  };
}
