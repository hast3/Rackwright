import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import WebShell from "./WebShell";
import { IS_WEB } from "./backend";
createRoot(document.getElementById("root")!).render(IS_WEB ? <WebShell /> : <App />);
