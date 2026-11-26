import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const controlPlaneDialogOpen = Atom.make(false);
export const openControlPlaneDialog = () => appAtomRegistry.set(controlPlaneDialogOpen, true);
