import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { api } from "../api.js";
import { createVariantSync } from "./variantSync.js";
export { diff, apply } from "./variantSync.js";

export function useVariantSync({ variant, onSaved, onError }) {
  const callbacks = useRef({ onSaved, onError });
  callbacks.current = { onSaved, onError };
  const controller = useMemo(
    () =>
      createVariantSync({
        variant,
        patch: api.patchVariant,
        onSaved: (saved) => callbacks.current.onSaved?.(saved),
        onError: (error) => callbacks.current.onError?.(error)
      }),
    [variant?.id]
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    const onUnload = (event) => {
      if (!controller.hasPending()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [controller]);
  return {
    ...snapshot,
    change: controller.change,
    flush: controller.flush,
    resolve: controller.resolve,
    applyRemote: controller.applyRemote,
    get revision() {
      return controller.revision;
    },
    get savedVariant() {
      return controller.variant;
    }
  };
}
