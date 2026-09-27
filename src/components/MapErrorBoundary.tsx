import { Component, type ReactNode } from "react";

/** Keeps the planner usable if the Maps API throws (bad key, blocked map ID, API outage). */
export default class MapErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(e: Error) {
    return { error: e.message || "The map stopped working" };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="map map-error">
        <div className="card">
          <h1>The map stopped working</h1>
          <p className="muted">{this.state.error}</p>
          <p>Your route and stops are safe. Check the API key and map ID, then reload.</p>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
