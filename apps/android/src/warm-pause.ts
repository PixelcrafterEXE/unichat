// Avatar pre-warming (Hub.warmAvatars) is a background nice-to-have: it costs provider requests, traffic and CPU for
// pictures nobody has asked for. On a phone that is wrong on mobile data and on a nearly empty battery, so the native
// side reports Android's own signals ($network {metered}, $power {saver,low}) and the Hub is paused with
// `setAvatarWarmPaused`. The signals arrive separately and each is repeated after a bridge reconnect, hence this tiny
// state holder: it ORs them and only answers when the result differs from what the Hub was already told.

export type HostConditions = {
  metered: boolean; // active network lacks NET_CAPABILITY_NOT_METERED
  saver: boolean;   // battery saver is on
  low: boolean;     // Android says the battery is low
};

export class WarmPause {
  private at: HostConditions = { metered: false, saver: false, low: false };
  private sent = false; // a fresh Hub is not paused

  /** Merges what the native side just reported; returns the value for setAvatarWarmPaused, or undefined if the Hub already knows it. */
  update(p: Partial<HostConditions>): boolean | undefined {
    this.at = { ...this.at, ...p };
    const paused = this.at.metered || this.at.saver || this.at.low;
    if (paused === this.sent) return undefined;
    this.sent = paused;
    return paused;
  }
}
