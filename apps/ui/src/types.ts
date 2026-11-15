// UI types come straight from the backend contract (type-only imports, erased at build).
export type {
  Space, Chat, ChatKind, ChatMerge, Message, Attachment, Reaction, Account, Contact, DeliveryStatus, Location, SharedContact, Card, CardImage,
} from "../../../packages/core/src/model";
export { cardsOf } from "../../../packages/core/src/model";
export type { Capabilities, LoginPrompt, LoginField, LoginWarning } from "../../../packages/core/src/provider";
import type { Capabilities } from "../../../packages/core/src/provider";
export interface ProviderInfo { name: string; displayName: string; login: "qr" | "form" | "link"; deprecated?: boolean; capabilities: Capabilities }

/** Effective capabilities of an account: its connector's live ones (Account.capabilities), else the provider-level defaults. */
export function capsOf(account: { capabilities?: Capabilities; provider?: string } | undefined, providers: ProviderInfo[], provider?: string): Capabilities | undefined {
  return account?.capabilities ?? providers.find((p) => p.name === (provider ?? account?.provider))?.capabilities;
}
export type { RailGroup } from "../../../packages/core/src/railgroups";
export type { UserCategory } from "../../../packages/core/src/categories";
