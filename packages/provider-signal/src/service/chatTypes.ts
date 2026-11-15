// libsignal adds the typed service methods to the chat connection classes through `declare module '../Chat'`
// augmentation, which TypeScript does not apply under moduleResolution NodeNext (extensionless specifier).
// At runtime the methods exist (installed on the prototype when `Net` is imported), so we re-assemble the
// types explicitly from the exported service interfaces.
import type { Net } from "@signalapp/libsignal-client";

export type AuthChat = Net.AuthenticatedChatConnection & Net.AuthKeysService & Net.AuthMessagesService & Net.AuthDevicesService;
export type UnauthChat = Net.UnauthenticatedChatConnection & Net.UnauthMessagesService & Net.UnauthKeysService & Net.UnauthProfilesService;
