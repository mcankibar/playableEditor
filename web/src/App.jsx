import { useEffect, useState } from "react";
import { GameList } from "./pages/GameList.jsx";
import { GameEditor } from "./pages/GameEditor.jsx";

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
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return route.page === "game" ? (
    <GameEditor key={route.gameId} gameId={route.gameId} variantId={route.variantId} />
  ) : (
    <GameList />
  );
}
