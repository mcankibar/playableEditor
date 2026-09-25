import { useEffect, useState } from "react";
import { GameList } from "./pages/GameList.jsx";
import { GameEditor } from "./pages/GameEditor.jsx";
import { AuthContext, Login } from "./auth.jsx";
import { UNAUTHORIZED_EVENT, api } from "./api.js";

// Routes: #/  ·  #/g/<gameId>  ·  #/g/<gameId>/v/<variantId>
function parseHash() {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "g" && parts[1]) return { page: "game", gameId: parts[1], variantId: Number(parts[3]) || null };
  return { page: "games" };
}

export const navigate = (hash) => {
  window.location.hash = hash;
};
export const gameHash = (gameId, variantId) => `#/g/${encodeURIComponent(gameId)}${variantId ? `/v/${variantId}` : ""}`;

export function App() {
  const [route, setRoute] = useState(parseHash);
  // undefined: checking the session · null: signed out
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    const onUnauthorized = () => setUser(null);
    window.addEventListener("hashchange", onHash);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    api.me().then(setUser, () => setUser(null));
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  if (user === undefined) return null;
  // The route stays in the address bar, so after signing in the same page opens.
  if (user === null) return <Login onSignedIn={setUser} />;

  const signOut = () => api.logout().finally(() => setUser(null));
  return (
    <AuthContext.Provider value={{ user, signOut }}>
      {route.page === "game" ? (
        <GameEditor key={route.gameId} gameId={route.gameId} variantId={route.variantId} />
      ) : (
        <GameList />
      )}
    </AuthContext.Provider>
  );
}
