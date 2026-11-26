import { createFileRoute, redirect } from "@tanstack/react-router";

import { ApproveAgentSurface } from "../components/auth/ApproveAgentSurface";
import { isHostedStaticApp } from "../hostedPairing";

export const Route = createFileRoute("/approve-agent")({
  beforeLoad: () => {
    if (!isHostedStaticApp()) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: ApproveAgentSurface,
});
