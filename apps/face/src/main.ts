// The face over the exact world Lois's sidecar has already bound.
// There is one product surface: Lois. Old walkthroughs live in git, not in
// the running app.

import { loadWorld } from "./world";
import { renderHgLoisFlow } from "./hg/lois-flow";

const root = document.getElementById("app");
if (!root) throw new Error("no #app");

async function start(): Promise<void> {
  if (location.pathname !== "/pane/lois") {
    const { mountNeon } = await import("./neon/launch");
    mountNeon(root!);
    return;
  }
  const world = await loadWorld();
  if (location.pathname !== "/pane/lois") history.replaceState({}, "", "/pane/lois");
  renderHgLoisFlow(root!, world);
}

void start().catch((error: unknown) => {
  const message = document.createElement("p");
  message.className = "statusline";
  message.textContent = `Lois could not open this world. ${error instanceof Error ? error.message : String(error)}`;
  root.replaceChildren(message);
});
