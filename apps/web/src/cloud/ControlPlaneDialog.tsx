import { useAtom } from "@effect/atom-react";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { controlPlaneDialogOpen } from "./controlPlanePrompt";
import { signInToCloud } from "./oidcAuth";
import { resolveCloudPublicConfig } from "./publicConfig";

export function ControlPlaneDialog() {
  const gt = useGT();
  const [open, setOpen] = useAtom(controlPlaneDialogOpen);
  const [address, setAddress] = useState(() => resolveCloudPublicConfig().relayUrl ?? "");
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const addressInvalid = Boolean(address.trim()) && !normalizeSecureRelayUrl(address);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
          setError(false);
        }
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Sign in</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id="control-plane-sign-in"
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending || !normalizeSecureRelayUrl(address)) return;
              setPending(true);
              try {
                await signInToCloud(address);
              } catch {
                setError(true);
              }
              setPending(false);
            }}
          >
            <Label htmlFor="control-plane-url">
              <T>Control panel address</T>
            </Label>
            <Input
              id="control-plane-url"
              type="url"
              placeholder="https://cp.example.com"
              autoComplete="url"
              spellCheck={false}
              aria-invalid={addressInvalid || error || undefined}
              aria-describedby={
                addressInvalid
                  ? "control-plane-url-hint"
                  : error
                    ? "control-plane-url-error"
                    : undefined
              }
              value={address}
              disabled={pending}
              onChange={(event) => {
                setAddress(event.target.value);
                setError(false);
              }}
            />
            {addressInvalid && (
              <p id="control-plane-url-hint" className="text-xs text-muted-foreground">
                {gt("Enter an HTTPS address, or use HTTP on localhost.")}
              </p>
            )}
            {error && (
              <p id="control-plane-url-error" role="alert" className="text-xs text-destructive">
                {gt("Could not start sign-in. Check the control panel address and try again.")}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose
            disabled={pending}
            render={<Button variant="outline" type="button" disabled={pending} />}
          >
            <T>Cancel</T>
          </DialogClose>
          <Button
            type="submit"
            form="control-plane-sign-in"
            disabled={pending || !normalizeSecureRelayUrl(address)}
          >
            <T>Continue</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
