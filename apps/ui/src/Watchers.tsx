// Background hosts that only wake up on an event (device move, relay permission, identity verification). They are a separate chunk that App mounts after the chat list is on screen.
import { MoveWatcher, RelayWatcher } from "./MoveDevice";
import { VerifyHost } from "./VerifyDialog";
export default function Watchers() { return <><MoveWatcher /><RelayWatcher /><VerifyHost /></>; }
