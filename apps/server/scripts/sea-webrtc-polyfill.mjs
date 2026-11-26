// The SEA resolves native packages from node_modules beside the installed executable.
import * as NodeModule from "node:module";

export const { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } =
  NodeModule.createRequire(import.meta.url)("node-datachannel/polyfill");
