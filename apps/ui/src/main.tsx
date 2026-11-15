import { fmtDuration, toBars, waveformOf, webmOpusToOgg } from "./util";
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./emoji.css";
import "./styles.css";
import "./mobile.css";
import "./pickers.css";
/** A bug in one component must not leave a blank page: show what happened and offer a reload. */
class Boundary extends Component<{ children: ReactNode }, { err?: Error }> {
  state: { err?: Error } = {};
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 640, margin: "10vh auto", font: "15px system-ui, sans-serif", color: "var(--fg, #ddd)" }}>
        <h2>Something went wrong in the display</h2>
        <p>Your accounts and messages are safe. This is a display bug; reloading usually fixes it.</p>
        <pre style={{ whiteSpace: "pre-wrap", opacity: 0.7, fontSize: 12 }}>{String(this.state.err.message).slice(0, 400)}</pre>
        <button onClick={() => location.reload()} style={{ padding: "8px 16px" }}>Reload</button>
      </div>);
  }
}
createRoot(document.getElementById("root")!).render(<Boundary><App /></Boundary>);

if (new URLSearchParams(location.search).has("mock")) (window as any).__voice = { fmtDuration, toBars, waveformOf, webmOpusToOgg }; // test hook (mock mode only)
