import type { ModelMessage } from "ai";

const OMITTED = "Older diver working context was omitted to bound context size. Use the saved summary and current capabilities to recover missing evidence; do not assume omitted work was undone.";

/** Evict whole assistant/tool-result groups, never half of a tool exchange. */
export function retainDiverMessages(messages: ModelMessage[], maxChars = 128_000): ModelMessage[] {
  const groups: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "tool" && groups.length) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  let chars = OMITTED.length + 100;
  let start = groups.length;
  while (start > 0) {
    const size = JSON.stringify(groups[start - 1]).length;
    if (chars + size > maxChars) break;
    chars += size;
    start -= 1;
  }
  return [
    ...(start > 0 ? [{ role: "system" as const, content: OMITTED }] : []),
    ...groups.slice(start).flat(),
  ];
}
