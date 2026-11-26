import { T } from "gt-react";
import { LogInIcon, RotateCwIcon, UserIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useCloudAuth } from "../../cloud/oidcAuth";
import { useCloudAuthPrompt } from "../../cloud/useCloudAuthPrompt";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarAvatar />;
}

function ConfiguredT3ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn, user } = useCloudAuth();
  const accountPage = useT3ConnectAccountPage();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={() => accountPage.open?.()}>
            <UserIcon />
            <span className="truncate">{user?.name ?? user?.email ?? <T>Account</T>}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {accountPage.portals}
    </>
  );
}

export function T3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn, loadFailed } = useCloudAuth();
  const { openAuthPrompt } = useCloudAuthPrompt();

  if (loadFailed) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <RotateCwIcon />
            <span>
              <T>Retry T3 Connect</T>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  if (!isLoaded || isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={openAuthPrompt}>
          <LogInIcon />
          <span>
            <T>Sign in to T3 Connect</T>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
