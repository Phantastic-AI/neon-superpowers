import "./styles.css";
import { serializePageContext, stringifyPageContext, type PageSnapshot, type VisiblePageContext } from "./page-context";

type CaptureResult = PageSnapshot | null;

const captureButton = requireElement<HTMLButtonElement>("capture");
const copyButton = requireElement<HTMLButtonElement>("copy");
const statusElement = requireElement<HTMLElement>("status");
const titleElement = requireElement<HTMLElement>("page-title");
const urlElement = requireElement<HTMLElement>("page-url");
const capturedAtElement = requireElement<HTMLElement>("captured-at");
const jsonOutput = requireElement<HTMLTextAreaElement>("json-output");

let latestJson = "";

captureButton.addEventListener("click", () => {
  void captureActiveTab();
});

copyButton.addEventListener("click", () => {
  void copyLatestJson();
});

async function captureActiveTab(): Promise<void> {
  setStatus("Capturing active tab…");
  setBusy(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab.id === undefined) {
      throw new Error("No active tab is available for capture.");
    }

    const [injection] = await chrome.scripting.executeScript<[], CaptureResult>({
      target: { tabId: tab.id },
      func: collectActivePageSnapshot
    });

    if (!injection?.result) {
      throw new Error("The active tab did not return page context.");
    }

    let screenshotDataUrl: string | undefined;
    try {
      screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch {
      screenshotDataUrl = undefined;
    }

    const context = serializePageContext({ ...injection.result, screenshotDataUrl });
    renderContext(context);
    setStatus("Captured. JSON is ready to copy.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Capture failed.";
    setStatus(message);
  } finally {
    setBusy(false);
  }
}

async function copyLatestJson(): Promise<void> {
  if (!latestJson) {
    return;
  }

  try {
    await navigator.clipboard.writeText(latestJson);
    setStatus("Copied JSON to clipboard.");
  } catch {
    jsonOutput.focus();
    jsonOutput.select();
    setStatus("Select and copy the JSON manually.");
  }
}

function renderContext(context: VisiblePageContext): void {
  latestJson = stringifyPageContext(context);
  titleElement.textContent = context.title || "Untitled page";
  urlElement.textContent = context.url || "Unknown URL";
  capturedAtElement.textContent = context.capturedAt;
  jsonOutput.value = latestJson;
  copyButton.disabled = false;
}

function setBusy(isBusy: boolean): void {
  captureButton.disabled = isBusy;
  captureButton.textContent = isBusy ? "Capturing…" : "Capture active tab";
}

function setStatus(message: string): void {
  statusElement.textContent = message;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }

  return element as T;
}

function collectActivePageSnapshot(): CaptureResult {
  const selectionText = globalThis.getSelection?.()?.toString() ?? "";
  const bodyText = document.body?.innerText ?? document.body?.textContent ?? "";

  return {
    url: globalThis.location.href,
    title: document.title,
    selectionText,
    bodyText
  };
}
