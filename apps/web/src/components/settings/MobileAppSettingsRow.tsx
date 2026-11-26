import { T, useGT } from "gt-react";

import { MOBILE_APP_URL } from "../../branding";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function MobileAppSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={gt("Connect to your server from your phone or tablet.")}
      control={
        <Button
          size="sm"
          variant="outline"
          render={<a href={MOBILE_APP_URL} target="_blank" rel="noreferrer noopener" />}
        >
          <T>Build from source</T>
        </Button>
      }
    />
  );
}
