import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "../lib/feedback";

/** Keeps the planner usable if the map throws (no WebGL, tile server down). */
export default class MapErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(e: Error) {
    return { error: e.message || "The map stopped working" };
  }

  componentDidCatch(e: Error, info: ErrorInfo) {
    reportError(`Map: ${e.message}`, `${e.stack ?? ""}\n${info.componentStack ?? ""}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="map map-error">
        <div className="card">
          <h1>The map stopped working</h1>
          <p className="muted">{this.state.error}</p>
          <p>Your route and stops are safe. Check that your browser supports WebGL and that the map servers are reachable, then reload.</p>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
