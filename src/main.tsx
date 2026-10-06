import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/coss/toast";
import { ThemeProvider } from "./components/theme";
import { LoaderPreview } from "./components/loader-preview";
import "./styles.css";
import FoundryApp from "./foundry-app";
import { useEffect, useState } from "react";
function ProfileApp() {
  const [profile, setProfile] = useState<{ profile: string; activated: boolean; blockers: string[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/profile", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("The server profile could not be verified");
      setProfile(await response.json());
    }).catch((error: unknown) => setError(error instanceof Error ? error.message : "Profile check failed"));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!profile) return <p className="p-6">Loading workspace profile…</p>;
  if (profile.profile === "foundry-iq") return <FoundryApp profile={{ ...profile, profile: "foundry-iq" }} />;
  if (profile.profile === "legacy") return <App />;
  return <p role="alert">Unknown server profile; login and retrieval remain disabled.</p>;
}
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error">
        <h1>Something went wrong.</h1>
        <p>Reload the page to return to your workspace.</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          {location.pathname === "/loader" ? <LoaderPreview /> : <ProfileApp />}
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
