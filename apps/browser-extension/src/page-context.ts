export type PageSnapshot = {
  url: string;
  title: string;
  selectionText?: string | null;
  bodyText?: string | null;
  screenshotDataUrl?: string | null;
};

export type VisiblePageContext = {
  url: string;
  title: string;
  visibleText: string;
  screenshotDataUrl?: string;
  capturedAt: string;
};

export const MAX_VISIBLE_TEXT_LENGTH = 25_000;

export function normalizeVisibleText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chooseVisibleText(snapshot: Pick<PageSnapshot, "selectionText" | "bodyText">): string {
  const selectedText = normalizeVisibleText(snapshot.selectionText);

  if (selectedText.length > 0) {
    return selectedText;
  }

  return normalizeVisibleText(snapshot.bodyText);
}

export function truncateVisibleText(value: string, maxLength = MAX_VISIBLE_TEXT_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}

export function serializePageContext(
  snapshot: PageSnapshot,
  capturedAt: Date = new Date(),
  maxVisibleTextLength = MAX_VISIBLE_TEXT_LENGTH
): VisiblePageContext {
  return {
    url: snapshot.url.trim(),
    title: normalizeVisibleText(snapshot.title),
    visibleText: truncateVisibleText(chooseVisibleText(snapshot), maxVisibleTextLength),
    ...(snapshot.screenshotDataUrl ? { screenshotDataUrl: snapshot.screenshotDataUrl } : {}),
    capturedAt: capturedAt.toISOString()
  };
}

export function stringifyPageContext(context: VisiblePageContext): string {
  return JSON.stringify(context, null, 2);
}
