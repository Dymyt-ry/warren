import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { XIcon } from "@phosphor-icons/react";
import { App } from "./dashboard";
import { useTransport } from "./api";
import { createSandbox } from "./sandbox";

useTransport(createSandbox());

function Demo() {
  const [guide, setGuide] = useState(true);
  return (
    <>
      {guide && (
        <aside className="fixed right-3 bottom-3 left-3 z-50 mx-auto flex max-w-3xl items-center gap-3 border border-border bg-background px-3 py-2 text-[13px] shadow-lg md:right-5 md:bottom-5 md:left-auto">
          <span className="min-w-0 flex-1">
            <strong>Sandbox:</strong> everything is simulated in your browser. Try <span className="font-mono">@claude-anna check the cart tests</span>.{" "}
            <a href="/">About Warren</a> · <a href="/#self-host">Self-hosting</a>
          </span>
          <button
            type="button"
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Dismiss sandbox guide"
            onClick={() => setGuide(false)}
          >
            <XIcon />
          </button>
        </aside>
      )}
      <App />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
