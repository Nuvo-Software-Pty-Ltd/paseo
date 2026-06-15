// Root error boundary — catches render-time crashes anywhere below it and
// reports them to PostHog (Error Tracking). The app had no error boundary before
// this, so an uncaught render error white-screened silently. Shared across web
// and native; `analytics` resolves to the platform implementation.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { analytics } from "./analytics";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class RootErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    analytics.captureException(error, { componentStack: info.componentStack });
  }

  reset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <View style={styles.fallback}>
            <Text style={styles.text}>Something went wrong.</Text>
            <Pressable onPress={this.reset} style={styles.retry} accessibilityRole="button">
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        )
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000000",
    padding: 24,
  },
  text: {
    color: "#ffffff",
    fontSize: 16,
  },
  retry: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: "#ffffff",
  },
  retryText: {
    color: "#000000",
    fontSize: 16,
    fontWeight: "600",
  },
});
