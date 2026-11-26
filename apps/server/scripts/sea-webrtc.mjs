// The SEA resolves native packages from node_modules beside the installed executable.
import * as NodeModule from "node:module";

const require = NodeModule.createRequire(import.meta.url);
export const { IceUdpMuxListener, PeerConnection } = require("node-datachannel");
export const {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} = require("node-datachannel/polyfill");
