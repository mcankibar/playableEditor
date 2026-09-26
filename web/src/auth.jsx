import { createContext, useContext, useState } from "react";
import { api } from "./api.js";
import { toggleTheme } from "./theme.js";

export const AuthContext = createContext({ user: null, signOut: () => {} });

/** Light / dark. The choice is kept on this browser. */
export function ThemeSwitch() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");
  return (
    <button
      type="button"
      className={`theme-switch${dark ? " on" : ""}`}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      onClick={() => setDark(toggleTheme() === "dark")}
    >
      <span />
    </button>
  );
}

/** Signed-in user's name and the sign-out button, for the top bars. */
export function UserMenu() {
  const { user, signOut } = useContext(AuthContext);
  if (!user) return null;
  if (user.authDisabled)
    return (
      <span className="user-menu">
        <span
          className="auth-off"
          title="The server runs with STUDIO_AUTH=0: no sign-in, anyone who can open it can edit"
        >
          Sign-in off
        </span>
        <ThemeSwitch />
      </span>
    );
  return (
    <span className="user-menu">
      <ThemeSwitch />
      <span className="muted">{user.username}</span>
      <button className="small" onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}

export function Login({ onSignedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSignedIn(await api.login(username.trim(), password));
    } catch (err) {
      setError(
        /Wrong username/.test(err.message)
          ? "Wrong username or password."
          : /Too many/.test(err.message)
            ? "Too many failed attempts. Try again in 15 minutes."
            : err.message
      );
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <ThemeSwitch />
      <form className="login-card" onSubmit={submit}>
        <h1>Playable Studio</h1>
        <label>
          Username
          <input
            type="text"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="muted small">Ask whoever runs the Studio for an account.</p>
      </form>
    </main>
  );
}
