import { MessageSquareIcon, ServerIcon, SmartphoneIcon } from "lucide-react";
import { msg, useMessages } from "gt-react";
import { type ReactNode, useState } from "react";

import { useCloudAuth } from "../../cloud/oidcAuth";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ChatUserProfilePage } from "./T3ChatUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";

const T3_CONNECT_ACCOUNT_PAGES = [
  {
    label: msg("Mobile clients"),
    url: "mobile-clients",
    icon: <SmartphoneIcon className="size-4" />,
    content: <MobileClientsUserProfilePage />,
  },
  {
    label: "T3 Connect",
    url: "t3-connect",
    icon: <ServerIcon className="size-4" />,
    content: <T3ConnectUserProfilePage />,
  },
  {
    label: "T3 Chat",
    url: "t3-chat",
    icon: <MessageSquareIcon className="size-4" />,
    content: <T3ChatUserProfilePage />,
  },
] as const;

export type T3ConnectAccountPageUrl = (typeof T3_CONNECT_ACCOUNT_PAGES)[number]["url"];

/**
 * Opens the account dialog. `portals` stays in the return value so callers that
 * rendered Clerk's custom-page portals keep working unchanged.
 */
export function useT3ConnectAccountPage(): {
  readonly open: ((page?: T3ConnectAccountPageUrl) => void) | null;
  readonly portals: ReactNode;
} {
  const { isSignedIn, signOut, user } = useCloudAuth();
  const m = useMessages();
  const [page, setPage] = useState<T3ConnectAccountPageUrl | null>(null);
  const current = T3_CONNECT_ACCOUNT_PAGES.find((candidate) => candidate.url === page);

  return {
    open: isSignedIn ? (next: T3ConnectAccountPageUrl = "t3-connect") => setPage(next) : null,
    portals: (
      <Dialog
        open={page !== null}
        onOpenChange={(open) => {
          if (!open) setPage(null);
        }}
      >
        <DialogPopup className="max-w-3xl">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <DialogTitle>{user?.name ?? user?.email ?? m(msg("Account"))}</DialogTitle>
            <Button size="sm" variant="outline" onClick={() => void signOut()}>
              {m(msg("Sign out"))}
            </Button>
          </div>
          <div className="flex min-h-80">
            <nav className="flex w-44 shrink-0 flex-col gap-1 border-r p-2">
              {T3_CONNECT_ACCOUNT_PAGES.map((candidate) => (
                <button
                  key={candidate.url}
                  type="button"
                  onClick={() => setPage(candidate.url)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60",
                    candidate.url === page && "bg-muted text-foreground",
                  )}
                >
                  {candidate.icon}
                  <span>{m(candidate.label)}</span>
                </button>
              ))}
            </nav>
            <div className="min-w-0 flex-1 p-4">{current?.content}</div>
          </div>
        </DialogPopup>
      </Dialog>
    ),
  };
}
