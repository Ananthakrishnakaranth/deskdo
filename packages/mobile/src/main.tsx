import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@deskdo/shared/ui/styles.css";
import "./app.css";
import { App } from "./App";
import { boot } from "./boot";

const root = createRoot(document.getElementById("root")!);
boot()
  .then((ctx) => root.render(<StrictMode><App {...ctx} /></StrictMode>))
  .catch((e: unknown) => {
    console.error(e);
    root.render(<p className="boot-error">Could not open local storage: {String(e)}</p>);
  });
