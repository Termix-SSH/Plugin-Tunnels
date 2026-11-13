import { useEffect } from "react";
import { usePermission, type TermixApp } from "@termix-ssh/plugin-sdk/frontend";

/** The container owner decides whether the current user can reach its UI. */
export function TunnelViewContainer({ app }: { app: TermixApp }) {
  const allowed = usePermission("use");
  useEffect(() => {
    if (!allowed) return;
    return app.registerExtension("tunnels.containers", {
      id: "tunnels.views",
      version: 1,
    });
  }, [app, allowed]);
  return null;
}
