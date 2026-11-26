import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render, stubGlobal } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { ControlPlaneDialog } from "./ControlPlaneDialog";
import { openControlPlaneDialog } from "./controlPlanePrompt";

it("lets a signed-out user correct the panel address and continue with its sign-in provider", async () => {
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <ControlPlaneDialog />
    </AppAtomRegistryProvider>,
  );
  const openExternal = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(true);
  using _desktop = stubGlobal("desktopBridge", { openExternal });
  const panel = "https://cp.example.test";
  const issuer = "https://id.example.test/realms/cove";
  using _storage = new DisposableStack();
  for (const [storage, key] of [
    [localStorage, "cove.control-plane"],
    [sessionStorage, "cove.control-plane"],
    [sessionStorage, "cove.oidc.pending"],
  ] as const) {
    const previous = storage.getItem(key);
    _storage.defer(() => {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    });
  }
  using network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    switch (String(input)) {
      case panel + "/.well-known/cove-control-plane":
        return Response.json({
          controlPlaneUrl: panel,
          oidc: { issuer, clientId: "cove-test", audience: null, scopes: ["openid", "email"] },
          libp2p: { enabled: false, peerId: null, relayMultiaddrs: [] },
        });
      case issuer + "/.well-known/openid-configuration":
        return Response.json({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/keys",
        });
      default:
        return new Response(null, { status: 404 });
    }
  });
  await act(openControlPlaneDialog);
  const address = page.getByRole("textbox", { name: "Control panel address" });
  const submit = page.getByRole("button", { name: "Continue" });
  await address.fill("http://cp.example.test");
  await expect
    .element(address)
    .toHaveAccessibleDescription("Enter an HTTPS address, or use HTTP on localhost.");
  await expect.element(submit).toBeDisabled();
  expect(network).not.toHaveBeenCalled();
  await address.fill("https://unavailable.example.test");
  await submit.click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(openExternal).not.toHaveBeenCalled();
  await address.fill(panel);
  await submit.click();
  await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
  const authorize = new URL(openExternal.mock.calls[0]![0]);
  expect(authorize.origin + authorize.pathname).toBe(issuer + "/authorize");
  expect(authorize.searchParams.get("client_id")).toBe("cove-test");
  expect(authorize.searchParams.get("scope")).toBe("openid email");
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(localStorage.getItem("cove.control-plane")).toBe(panel);
  expect(sessionStorage.getItem("cove.control-plane")).toBe(panel);
});
