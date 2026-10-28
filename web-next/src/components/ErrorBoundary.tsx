import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Result } from "antd";

interface ErrorBoundaryState {
  error: Error | null;
}

/** Last-resort boundary: a render crash shows a recoverable page, not a blank root. */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("pir web-next render failure", error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24 }}>
          <Result
            status="error"
            title="This view failed to render"
            subTitle={this.state.error.message}
            extra={<Button type="primary" onClick={() => { this.setState({ error: null }); window.location.reload(); }}>Reload workspace</Button>}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
