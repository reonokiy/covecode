export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const basePath = url.pathname.replace(/\/+$/gu, "");
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.pathname = basePath.length > 0 && basePath !== "/" ? `${basePath}${suffix}` : suffix;
  url.search = "";
  url.hash = "";
  return url.toString();
};
