import { postEnvironmentFile } from "@t3tools/client-runtime/environment";
import { msg } from "gt-react";
import { m } from "../i18n/messages";

const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export async function uploadEnvironmentFile(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: number) => void;
}): Promise<void> {
  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  let status: number;
  try {
    status = await postEnvironmentFile(
      input.url,
      input.file,
      input.mimeType,
      AbortSignal.any([input.signal, timeout]),
      input.onProgress,
    );
  } catch {
    if (input.signal.aborted) throw new Error(m(msg("Upload cancelled")));
    if (timeout.aborted) throw new Error(m(msg("Upload timed out")));
    throw new Error(m(msg("Upload failed")));
  }
  if (status < 200 || status >= 300)
    throw new Error(m(msg("Upload rejected ({status})", { status })));
}
