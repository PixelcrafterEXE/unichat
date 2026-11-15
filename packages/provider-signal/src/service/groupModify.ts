// Groups v2 MODIFY: create a group, add/remove members, rename, change/remove the picture, leave.
// Every change is a GroupChange.Actions protobuf (version = current revision + 1) sent as PATCH /v2/groups/ on storage.signal.org,
// authorised with the group-scoped auth credential presentation (GroupResolver.authFor), exactly like the state fetch.
//   * Titles/avatars are zkgroup blobs (ClientZkGroupCipher.encryptBlob), member ids are UuidCiphertexts.
//   * Adding a member needs a ProfileKeyCredential presentation: profile key (learned from their messages) ->
//     ProfileKeyCredentialRequestContext -> unauthenticated chat `getProfileKeyCredential` -> presentation for THIS group.
//     Without a known profile key (or if the credential fetch fails) the person is invited as a *pending member* instead.
//   * Avatar: GET /v2/groups/avatar/form (AvatarUploadAttributes) -> encrypted GroupAttributeBlob{avatar} multipart POST to cdn0 -> path in modifyAvatar.
//   * 409 (revision conflict): refetch the group state and rebuild the action once more (max 3 tries). 403: plain "only admins" error.
// ALL WIRE DETAILS HERE ARE FROM KNOWLEDGE OF THE OFFICIAL CLIENTS AND ARE UNVERIFIED AGAINST THE LIVE SERVICE (README "Unverified").
import { randomBytes } from "node:crypto";
import { Aci } from "@signalapp/libsignal-client";
import {
  ClientZkGroupCipher, ClientZkProfileOperations, ExpiringProfileKeyCredential, GroupMasterKey, GroupSecretParams, ProfileKey,
} from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import {
  GroupActionsCodec, GroupAttributeBlobCodec, GroupChangeCodec, GroupChangeResponseCodec, GroupCodec, GroupMemberRole, type GroupActionsPb, type GroupPb, type MemberPb,
} from "../protocol/codec.js";
import { toBytes } from "../protocol/bytes.js";
import type { SignalStore } from "../store/signalStore.js";
import type { UnauthChat } from "./chatTypes.js";
import { groupChatId, groupIdFromMasterKey } from "./groups.js";
import { GroupsHttpError, groupsDebug, parseAvatarForm, type GroupResolver, type GroupsTransport } from "./groupState.js";

const AccessRequired = { MEMBER: 2, ADMINISTRATOR: 3, UNSATISFIABLE: 4 } as const;
export const MAX_GROUP_AVATAR_BYTES = 1024 * 1024;

/** A failure with a message that is safe and useful to show as is. */
export class GroupEditError extends Error {
  constructor(message: string, readonly kind: "permission" | "conflict" | "network" | "invalid" | "not-ready") { super(message); this.name = "GroupEditError"; }
}

export interface GroupChangeResult {
  revision: number;
  /** The server-signed GroupChange to put into GroupContextV2.groupChange (empty when the server did not return one). */
  groupChange: Uint8Array;
  /** Members (pending included) that must be told: the current ones plus anybody just removed. */
  notify: string[];
  /** People who were invited instead of added (no profile key / credential). */
  invited: string[];
}

export interface EditorDeps {
  store: SignalStore;
  resolver: Pick<GroupResolver, "authFor" | "request" | "ensure" | "publicServerParams">;
  transport: () => GroupsTransport;
  unauth: () => Promise<UnauthChat | undefined>;
  /** Plain upload of the encrypted avatar (defaults to the transport's). */
  now?: () => number;
}

const aciLc = (s: string) => s.toLowerCase();

export class GroupEditor {
  private credentials = new Map<string, ExpiringProfileKeyCredential>();
  constructor(private readonly d: EditorDeps) {}
  private now() { return this.d.now ? this.d.now() : Date.now(); }

  private profileKeyOf(aci: string): ProfileKey | undefined {
    const me = this.d.store.requireAccount();
    const b64 = aciLc(aci) === aciLc(me.aci) ? me.profileKey : this.d.store.data.contacts[aciLc(aci)]?.profileKey;
    return b64 ? new ProfileKey(toBytes(Buffer.from(b64, "base64"))) : undefined;
  }

  /** ProfileKeyCredentialPresentation for `aci` in the group of `secret`, or undefined when not obtainable. */
  private async presentation(aci: string, secret: GroupSecretParams): Promise<Uint8Array | undefined> {
    const pk = this.profileKeyOf(aci);
    if (!pk) return undefined;
    try {
      const params = this.d.resolver.publicServerParams();
      const ops = new ClientZkProfileOperations(params);
      let cred = this.credentials.get(aciLc(aci));
      if (!cred || cred.getExpirationTime().getTime() - this.now() < 60 * 60_000) {
        const unauth = await this.d.unauth();
        if (!unauth) return undefined;
        const ctx = ops.createProfileKeyCredentialRequestContext(Aci.fromUuid(aci), pk);
        cred = await unauth.getProfileKeyCredential({ requestContext: ctx, serverParams: params });
        this.credentials.set(aciLc(aci), cred);
      }
      return ops.createExpiringProfileKeyCredentialPresentation(secret, cred).serialize();
    } catch (e) {
      groupsDebug(`credential failed reason=${e instanceof Error ? e.name : "unknown"}`);
      return undefined;
    }
  }

  private blob(cipher: ClientZkGroupCipher, o: object): Uint8Array { return cipher.encryptBlob(toBytes(GroupAttributeBlobCodec.encode(o))); }

  private async uploadAvatar(secret: GroupSecretParams, data: Uint8Array): Promise<string> {
    if (data.length === 0 || data.length > MAX_GROUP_AVATAR_BYTES) throw new GroupEditError("The group picture must be smaller than 1 MB.", "invalid");
    const auth = await this.d.resolver.authFor(secret);
    let form;
    try { form = parseAvatarForm(await this.d.transport().avatarForm(auth)); }
    catch (e) { throw this.mapHttp(e, "change the group picture"); }
    if (!form.key) throw new GroupEditError("Signal didn't accept the group picture upload. Try again later.", "network");
    const encrypted = this.blob(new ClientZkGroupCipher(secret), { avatar: data });
    try { await this.d.transport().uploadAvatar(form, encrypted); }
    catch (e) { throw this.mapHttp(e, "change the group picture"); }
    return form.key;
  }

  private mapHttp(e: unknown, what: string): GroupEditError {
    if (e instanceof GroupEditError) return e;
    if (e instanceof GroupsHttpError) {
      if (e.status === 403) return new GroupEditError(`Only group admins can ${what} in this group (or you are no longer a member).`, "permission");
      if (e.status === 409) return new GroupEditError("The group was changed by someone else at the same time. Try again.", "conflict");
      if (e.status === 429) return new GroupEditError("Signal is busy; try again shortly.", "network");
      return new GroupEditError(`Signal didn't accept the change (HTTP ${e.status}).`, "network");
    }
    return new GroupEditError("Couldn't reach Signal to change the group. Check your connection and try again.", "network");
  }

  // ---------- create ----------
  async create(name: string, memberAcis: string[], avatar?: Uint8Array): Promise<{ chatId: string; masterKey: Uint8Array; revision: number; notify: string[]; invited: string[] }> {
    const me = this.d.store.requireAccount().aci;
    const title = name.trim();
    if (!title) throw new GroupEditError("A group needs a name.", "invalid");
    const others = [...new Set(memberAcis.map(aciLc))].filter((a) => a !== aciLc(me));
    if (others.length === 0) throw new GroupEditError("Add at least one other person to the group.", "invalid");
    const masterKey = new Uint8Array(randomBytes(32));
    const secret = GroupSecretParams.deriveFromMasterKey(new GroupMasterKey(toBytes(masterKey)));
    const cipher = new ClientZkGroupCipher(secret);
    const myPresentation = await this.presentation(me, secret);
    if (!myPresentation) throw new GroupEditError("Couldn't prepare your own group credential (profile key or connection missing). Try again in a minute.", "not-ready");
    const members: MemberPb[] = [{ role: GroupMemberRole.ADMINISTRATOR, presentation: myPresentation }];
    const pending: { member: MemberPb }[] = [];
    const invited: string[] = [];
    for (const a of others) {
      const p = await this.presentation(a, secret);
      if (p) members.push({ role: GroupMemberRole.DEFAULT, presentation: p });
      else { pending.push({ member: { userId: cipher.encryptServiceId(Aci.fromUuid(a)).serialize(), role: GroupMemberRole.DEFAULT } }); invited.push(a); }
    }
    const group: GroupPb = {
      publicKey: secret.getPublicParams().serialize(), title: this.blob(cipher, { title }), version: 0,
      disappearingMessagesTimer: this.blob(cipher, { disappearingMessagesDuration: 0 }),
      accessControl: { attributes: AccessRequired.MEMBER, members: AccessRequired.MEMBER, addFromInviteLink: AccessRequired.UNSATISFIABLE },
      members, membersPendingProfileKey: pending,
    };
    if (avatar?.length) group.avatar = await this.uploadAvatar(secret, avatar);
    const auth = await this.d.resolver.authFor(secret);
    try { await this.d.transport().createGroup(auth, GroupCodec.encode(group)); }
    catch (e) { throw this.mapHttp(e, "create groups"); }
    const chatId = groupChatId(groupIdFromMasterKey(masterKey));
    this.d.store.upsertChat({ id: chatId, kind: "group", name: title, groupMasterKey: Buffer.from(masterKey).toString("base64") });
    await this.d.resolver.request(chatId, undefined, { force: true, ignoreCooldown: true });
    const rec = this.d.store.data.chats[chatId];
    groupsDebug(`created members=${members.length} invited=${pending.length}`);
    return { chatId, masterKey, revision: rec?.groupRevision ?? 0, notify: others, invited };
  }

  // ---------- modify ----------
  /**
   * Apply one change. `build` gets the secret/cipher/current state and returns the action fields (version is added here).
   * `what` completes "Only group admins can <what>".
   */
  async modify(
    chatId: string, what: string,
    build: (c: { secret: GroupSecretParams; cipher: ClientZkGroupCipher; members: string[] }) => Promise<Partial<GroupActionsPb>>,
  ): Promise<GroupChangeResult> {
    const rec0 = this.d.store.data.chats[chatId];
    if (!rec0?.groupMasterKey) throw new GroupEditError("This isn't a Signal group.", "invalid");
    const secret = GroupSecretParams.deriveFromMasterKey(new GroupMasterKey(toBytes(Buffer.from(rec0.groupMasterKey, "base64"))));
    const cipher = new ClientZkGroupCipher(secret);
    if ((await this.d.resolver.ensure(chatId, 60_000)) === "missing") throw new GroupEditError("Couldn't load this group's details from Signal. Check your connection and try again in a minute.", "not-ready");
    const before = new Set<string>();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rec = this.d.store.data.chats[chatId]!;
      const members = (rec.groupMembers ?? []).map(aciLc);
      members.forEach((m) => before.add(m));
      const actions: GroupActionsPb = { ...(await build({ secret, cipher, members })), version: (rec.groupRevision ?? 0) + 1 };
      const auth = await this.d.resolver.authFor(secret);
      try {
        const body = await this.d.transport().modifyGroup(auth, GroupActionsCodec.encode(actions));
        let change: Uint8Array = new Uint8Array();
        try {
          const r = body.length ? GroupChangeResponseCodec.decode(body) : undefined;
          if (r?.groupChange) change = GroupChangeCodec.encode(r.groupChange);
        } catch { /* a missing change only means members learn the new state by fetching it */ }
        await this.d.resolver.request(chatId, undefined, { force: true, ignoreCooldown: true });
        const after = this.d.store.data.chats[chatId];
        const now = new Set((after?.groupMembers ?? []).map(aciLc));
        const removed = [...before].filter((m) => !now.has(m));
        const me = aciLc(this.d.store.requireAccount().aci);
        groupsDebug(`modify ok attempts=${attempt + 1} revision=${after?.groupRevision ?? actions.version}`);
        return { revision: actions.version!, groupChange: change, notify: [...new Set([...now, ...removed])].filter((m) => m !== me), invited: [] };
      } catch (e) {
        lastErr = e;
        if (e instanceof GroupsHttpError && e.status === 409) {
          groupsDebug(`modify conflict attempt=${attempt + 1}`);
          await this.d.resolver.request(chatId, undefined, { force: true, ignoreCooldown: true });
          continue;
        }
        throw this.mapHttp(e, what);
      }
    }
    throw this.mapHttp(lastErr, what);
  }

  async addMembers(chatId: string, acis: string[]): Promise<GroupChangeResult> {
    const invited: string[] = [];
    const res = await this.modify(chatId, "add members", async ({ secret, cipher, members }) => {
      invited.length = 0;
      const fresh = [...new Set(acis.map(aciLc))].filter((a) => !members.includes(a));
      if (fresh.length === 0) throw new GroupEditError("They are already in this group.", "invalid");
      const addMembers: NonNullable<GroupActionsPb["addMembers"]> = [];
      const addPendingMembers: NonNullable<GroupActionsPb["addPendingMembers"]> = [];
      for (const a of fresh) {
        const p = await this.presentation(a, secret);
        if (p) addMembers.push({ added: { role: GroupMemberRole.DEFAULT, presentation: p } });
        else { addPendingMembers.push({ added: { member: { userId: cipher.encryptServiceId(Aci.fromUuid(a)).serialize(), role: GroupMemberRole.DEFAULT } } }); invited.push(a); }
      }
      return { ...(addMembers.length ? { addMembers } : {}), ...(addPendingMembers.length ? { addPendingMembers } : {}) };
    });
    // invitees are not in groupMembers: tell them explicitly
    return { ...res, invited, notify: [...new Set([...res.notify, ...acis.map(aciLc)])].filter((m) => m !== aciLc(this.d.store.requireAccount().aci)) };
  }

  async removeMember(chatId: string, aci: string): Promise<GroupChangeResult> {
    const target = aciLc(aci);
    return this.modify(chatId, "remove members", async ({ cipher, members }) => {
      const id = cipher.encryptServiceId(Aci.fromUuid(target)).serialize();
      return members.includes(target) ? { deleteMembers: [{ deletedUserId: id }] } : { deletePendingMembers: [{ deletedUserId: id }] };
    });
  }

  async rename(chatId: string, name: string): Promise<GroupChangeResult> {
    const title = name.trim();
    if (!title) throw new GroupEditError("The group name can't be empty.", "invalid");
    return this.modify(chatId, "rename the group", async ({ cipher }) => ({ modifyTitle: { title: this.blob(cipher, { title }) } }));
  }

  async setDescription(chatId: string, text: string): Promise<GroupChangeResult> {
    const t = text.trim();
    return this.modify(chatId, "change the group description", async ({ cipher }) => ({ modifyDescription: t ? { descriptionBytes: this.blob(cipher, { descriptionText: t }) } : {} }));
  }

  async setPicture(chatId: string, image: Uint8Array | null): Promise<GroupChangeResult> {
    return this.modify(chatId, "change the group picture", async ({ secret }) => {
      if (!image) return { modifyAvatar: {} }; // an empty ModifyAvatarAction clears the picture
      return { modifyAvatar: { avatar: await this.uploadAvatar(secret, image) } };
    });
  }

  async leave(chatId: string): Promise<GroupChangeResult> {
    const rec = this.d.store.data.chats[chatId];
    const me = aciLc(this.d.store.requireAccount().aci);
    const admins = (rec?.groupAdmins ?? []).map(aciLc);
    const others = (rec?.groupMembers ?? []).map(aciLc).filter((m) => m !== me);
    if (admins.includes(me) && admins.length === 1 && others.length > 0) {
      throw new GroupEditError("You are the only admin of this group. Make someone else an admin in Signal on your phone first, then leave.", "permission");
    }
    return this.modify(chatId, "leave the group", async ({ cipher }) => ({ deleteMembers: [{ deletedUserId: cipher.encryptServiceId(Aci.fromUuid(me)).serialize() }] }));
  }
}
