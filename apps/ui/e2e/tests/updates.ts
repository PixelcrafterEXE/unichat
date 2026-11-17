// Self-update UI: Settings > Updates, the banner, desktop/Android flow and phone width (mock backend, see src/mockUpdate.ts).
import { test } from "../lib/test.ts";
import { settings } from "../lib/ui.ts";

const log = `(globalThis.__mockUpdateLog||[]).map(x=>x.method)`;
const noOverflow = `(()=>{const W=innerWidth; return document.documentElement.scrollWidth<=W && [...document.querySelectorAll('.upd, .upd *, #upd-banner, #upd-banner *')].every(e=>{const r=e.getBoundingClientRect(); return r.width===0||r.right<=W+1})})()`;

export default [
  test("Updates shows the version and an up-to-date state; Check now works", async (t) => {
    await t.open(); await settings(t, "Updates"); await t.waitSel("#updates");
    await t.ok("version is shown (dev in a local build)", `document.querySelector('#upd-version').textContent==='dev'`);
    await t.ok("not checked yet", `/Not checked yet/.test(document.querySelector('#upd-status').textContent)`);
    await t.click("#upd-check");
    await t.ok("last checked is filled in", `document.querySelector('#upd-last').textContent!=='never'`);
    await t.not("no update button", `document.querySelector('#upd-download')`);
    await t.not("no banner", `document.querySelector('#upd-banner')`);
  }),

  test("update available: banner, download with progress, confirm, install handoff", async (t) => {
    await t.open("&update=avail"); await settings(t, "Updates");
    await t.click("#upd-check");
    await t.ok("status names the version", `/0\\.1\\.9 is available/.test(document.querySelector('#upd-status').textContent)`);
    await t.ok("release notes shown", `/Faster start-up/.test(document.querySelector('#upd-notes').textContent)`);
    await t.click("#upd-download");
    await t.ok("ready after the download", `document.querySelector('#upd-install')`, { timeout: 8000 });
    await t.click("#upd-install");
    await t.ok("asks before installing", `/Update to 0\\.1\\.9\\?/.test(document.querySelector('#upd-confirm').textContent) && /restarts/.test(document.querySelector('#upd-confirm').textContent)`);
    await t.click("#upd-confirm-go");
    await t.ok("installer was started with the verified file", `${log}.includes('updateInstall') && ${log}.includes('$installApk')`);
    await t.ok("user is told what happens", `/confirm the update/.test(document.querySelector('#upd-msg').textContent)`);
    await t.shot("update_available");
  }),

  test("Android: missing 'install unknown apps' permission is explained, second try installs", async (t) => {
    await t.open("&update=needperm"); await settings(t, "Updates");
    await t.click("#upd-check"); await t.click("#upd-download"); await t.ok("ready", `document.querySelector("#upd-install")`, { timeout: 8000 }); await t.click("#upd-install"); await t.click("#upd-confirm-go");
    await t.ok("explains the permission", `/needs your OK to install apps/.test(document.querySelector('#upd-msg')?.textContent||'')`);
    await t.click("#upd-install"); await t.click("#upd-confirm-go");
    await t.ok("then starts the installer", `/asking you to confirm/.test(document.querySelector('#upd-msg')?.textContent||'')`);
  }),

  // A .deb / pacman install cannot install itself. It used to hide behind a confirmation that promised a restart and then,
  // when the file manager did not open, said nothing at all (Arch: "downloads, then a dead end").
  test("Linux package: the install command is shown, with no restart confirmation", async (t) => {
    await t.open("&update=manual"); await settings(t, "Updates");
    await t.click("#upd-check"); await t.click("#upd-download");
    await t.ok("ready after the download", `document.querySelector('#upd-install')`, { timeout: 8000 });
    await t.eq("the button says what it will do", `document.querySelector('#upd-install').textContent.trim()`, "How to install it");
    await t.click("#upd-install");
    await t.not("nothing promises a restart", `document.querySelector('#upd-confirm')`);
    await t.ok("the command to run is shown", `/sudo pacman -U .*unichat-desktop-0\\.1\\.9\\.pkg\\.tar\\.zst/.test(document.querySelector('#upd-manual-cmd')?.textContent||'')`);
    await t.ok("and can be copied", `!!document.querySelector('#upd-manual-copy')`);
    await t.shot("update_manual");
  }),

  test("Linux package: a failing install call still leaves the command on screen", async (t) => {
    await t.open("&update=manualfail"); await settings(t, "Updates");
    await t.click("#upd-check"); await t.click("#upd-download");
    await t.ok("ready after the download", `document.querySelector('#upd-install')`, { timeout: 8000 });
    await t.click("#upd-install");
    await t.ok("the failure is reported", `/Could not open the folder/.test(document.querySelector('#upd-msg')?.textContent||'')`);
    await t.ok("and the command is there anyway", `/sudo pacman -U/.test(document.querySelector('#upd-manual-cmd')?.textContent||'')`);
  }),

  test("banner: Update opens the Updates section and takes the banner down, Later hides it for that version", async (t) => {
    await t.open("&update=avail");
    await settings(t, "Updates"); await t.click("#upd-check"); await t.click(".settings .closex");
    await t.ok("banner appears after a check found one", `/Update 0\\.1\\.9 available/.test(document.querySelector('#upd-banner')?.textContent||'')`);
    await t.click("#upd-banner-go");
    await t.ok("Update opens the Updates section", `document.querySelector('.settings #updates')`);
    await t.click(".settings .closex");
    await t.not("acting on the banner takes it down (it used to stay behind the settings panel)", `document.querySelector('#upd-banner')`);
    await t.ev(`localStorage.removeItem('unichat.update.later')`); await t.reload(); // offer the same version again
    await settings(t, "Updates"); await t.click("#upd-check"); await t.click(".settings .closex");
    await t.click("#upd-banner-later");
    await t.not("Later hides the banner", `document.querySelector('#upd-banner')`);
  }),

  test("web host: tells about the new version but offers no install, and shows no banner", async (t) => {
    await t.open("&update=web"); await settings(t, "Updates"); await t.click("#upd-check");
    await t.ok("status names the version", `/0\\.1\\.9 is available/.test(document.querySelector('#upd-status').textContent)`);
    await t.not("no download button", `document.querySelector('#upd-download')`);
    await t.ok("explains who updates it", `/whoever runs the server/.test(document.querySelector('#updates').textContent)`);
    await t.click(".settings .closex"); await t.stays("no banner", `document.querySelector('#upd-banner')`, 400);
  }),

  test("offline check shows a plain error", async (t) => {
    await t.open("&update=fail"); await settings(t, "Updates"); await t.click("#upd-check");
    await t.ok("error text", `/internet connection/.test(document.querySelector('#upd-error')?.textContent||'')`);
  }),

  test("Advanced: repo validation, token field is a password field and is never echoed", async (t) => {
    await t.open(); await settings(t, "Updates");
    await t.click("#updates summary");
    await t.ok("token input is type=password", `document.querySelector('#upd-token').type==='password'`);
    await t.setInput("#upd-repo", "not a repo"); await t.click("#upd-save");
    await t.ok("bad repo is rejected", `/owner\\/name/.test(document.querySelector('#upd-msg')?.textContent||'')`);
    await t.setInput("#upd-repo", "me/other"); await t.setInput("#upd-token", "ghp_secretvalue"); await t.click("#upd-save");
    await t.ok("saved; the token field is emptied and only 'one is saved' shows", `document.querySelector('#upd-token').value==='' && /one is saved/.test(document.querySelector('#updates').textContent) && !document.body.innerHTML.includes('ghp_secretvalue')`);
    await t.ok("the repo was sent", `(globalThis.__mockUpdateLog||[]).some(x=>x.method==='updateSettings'&&x.params.repo==='me/other')`);
    await t.click("#upd-token-clear");
    await t.not("token removed", `/one is saved/.test(document.querySelector('#updates').textContent)`);
    await t.click("#upd-auto");
    await t.ok("auto-check toggle is saved", `(globalThis.__mockUpdateLog||[]).some(x=>x.method==='updateSettings'&&x.params.auto===false)`);
  }),

  test("phone: Updates section and banner fit the screen", async (t) => {
    await t.device("phone"); await t.open("&update=avail"); await settings(t, "Updates");
    await t.click("#upd-check"); await t.waitSel("#upd-download"); await t.click("#updates summary");
    await t.ok("no horizontal overflow in Updates", noOverflow);
    await t.click("#upd-download"); await t.ok("ready", `document.querySelector("#upd-install")`, { timeout: 8000 });
    await t.ok("still fits with the install button", noOverflow);
    await t.click(".settings .closex");
    await t.ok("banner inside the viewport", `(()=>{const r=document.querySelector('#upd-banner')?.getBoundingClientRect(); return !!r && r.left>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1})()`);
    await t.ok("banner has no overflow", noOverflow);
    await t.shot("phone_update_banner");
  }),
];
