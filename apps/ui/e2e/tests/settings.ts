// Settings: backup export / import / chat export in a browser (no desktop shell), appearance.
import { test } from "../lib/test.ts";
import { settings } from "../lib/ui.ts";

const upload = (t: any, text: string) => t.ev(`(()=>{const f=new File([${JSON.stringify(text)}],'x.unimsg-backup');const dt=new DataTransfer();dt.items.add(f);const i=document.querySelector('#bk-file');i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const openData = async (t: any) => { await t.open(); await settings(t, "Backup & restore"); await t.waitSel("#bk-export"); };

export default [
  test("backup export: passphrase rules, session warning, progress, result", async (t) => {
    await openData(t);
    await t.ok("Data section shows export and import", `document.querySelector('#bk-export') && document.querySelector('#bk-import')`);
    await t.ok("export disabled without passphrase", `document.querySelector('#bk-go').disabled`);
    await t.setInput("#bk-pw", "abc");
    await t.ok("weak passphrase hint", `/Weak/.test(document.querySelector('.strength').textContent)`);
    await t.setInput("#bk-pw", "correct horse battery staple"); await t.setInput("#bk-pw2", "correct horse battery stapl");
    await t.ok("mismatch blocks export", `document.querySelector('#bk-go').disabled`);
    await t.setInput("#bk-pw2", "correct horse battery staple");
    await t.ok("strong + match enables export", `!document.querySelector('#bk-go').disabled && /Strong/.test(document.querySelector('.strength').textContent)`);
    await t.click("#bk-sess");
    await t.ok("including sessions needs an acknowledgement", `document.querySelector('#bk-go').disabled && /must not run the same account/.test(document.querySelector('.warn').textContent)`);
    await t.shot("export_warn");
    await t.click("#bk-ack"); await t.click("#bk-go");
    await t.ok("progress bar while exporting", `document.querySelector('#bk-export .bar')`);
    await t.ok("done message with name and checksum", `/unimsg-2026.*\\.unimsg-backup/.test(document.querySelector('#bk-done')?.textContent||'') && /aaaaaaaa/.test(document.querySelector('#bk-done').textContent)`, { timeout: 8000 });
    await t.shot("export_done");
  }),

  test("backup import: errors, inspect, result, moved accounts", async (t) => {
    await openData(t);
    await upload(t, "garbage"); await t.setInput("#bk-ipw", "whatever12"); await t.click("#bk-check");
    await t.ok("non-backup file gives a clear error", `/not an Unimsg backup/.test(document.querySelector('#bk-ierr')?.textContent||'')`);
    await upload(t, "MOCKBK:secret-pass:sessions"); await t.setInput("#bk-ipw", "wrong-pass1"); await t.click("#bk-check");
    await t.ok("wrong passphrase error", `/Wrong passphrase/.test(document.querySelector('#bk-ierr')?.textContent||'')`);
    await t.setInput("#bk-ipw", "secret-pass"); await t.click("#bk-check");
    await t.ok("inspect shows counts, accounts and the session warning", `(x=>/1234 messages/.test(x)&&/Old phone/.test(x)&&/already here/.test(x)&&/will not start by themselves/.test(x))(document.querySelector('#bk-info')?.textContent||'')`);
    await t.shot("inspect");
    await t.click("#bk-import-go");
    await t.ok("result summary with sign-in count", `/1200 messages added/.test(document.querySelector('#bk-result')?.textContent||'') && /1 account needs sign-in/.test(document.querySelector('#bk-needsign')?.textContent||'')`, { timeout: 8000 });
    await t.ok("moved accounts box offers confirmation", `/Moved accounts/.test(document.querySelector('#bk-moved')?.textContent||'')`);
    await t.shot("result");
    await t.click("#bk-moved button", /start here/);
    await t.not("confirming removes the moved box", `document.querySelector('#bk-moved')`);
  }),

  test("export a single chat from its info panel", async (t) => {
    await t.open("&chat=wa-1:ben&info=1");
    await t.waitSel("#exportchat");
    await t.click("#exportchat"); await t.click("#exportchat-go");
    await t.ok("chat export reports its result", `/Exported \\d+ messages/.test(document.querySelector('#exportchat-msg')?.textContent||'')`, { timeout: 8000 });
    await t.shot("chat_export");
  }),

  test("appearance section opens", async (t) => {
    await t.open();
    await settings(t, "Appearance");
    await t.ok("appearance section opens with the collapse setting", `document.querySelector('#collapseSingle')`);
  }, { init: `try{localStorage.setItem('unimsg.settings',JSON.stringify({theme:'light'}))}catch(e){}` }),

  test("date format setting: applies live to the day separators, is remembered, and 'System default' restores the old look", async (t) => {
    await t.open("&chat=mx-1:!rust-general");
    await t.waitSel(".messages .daysep");
    const seps = `[...document.querySelectorAll('.messages .daysep')].map(e=>e.textContent).filter(x=>x!=='Today'&&x!=='Yesterday')`;
    const before = await t.ev<string[]>(seps);
    t.check("the chat has an older day separator", before.length > 0, JSON.stringify(before));
    t.check("system default writes a month name", /[A-Za-z]{3}/.test(before[0] ?? ""), before[0]);
    const pick = (v: string) => t.ev(`(()=>{const s=document.querySelector('#dateFormat'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(v)}); s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await settings(t, "Appearance");
    await t.waitSel("#dateFormat");
    t.check("offers the formats", (await t.ev<number>(`document.querySelectorAll('#dateFormat option').length`)) === 5);
    for (const [v, re] of [["ymd", "^[A-Za-z]+, \\d{4}-\\d{2}-\\d{2}$"], ["dmy", "^[A-Za-z]+, \\d{2}\\.\\d{2}\\.\\d{4}$"], ["mdy", "^[A-Za-z]+, \\d{2}/\\d{2}/\\d{4}$"], ["dmon", "^[A-Za-z]+, \\d{1,2} [A-Za-z]{3}\\.? \\d{4}$"]] as const) {
      await pick(v);
      await t.ok(`${v}: separators use the format`, `(${seps}).every(x=>new RegExp(${JSON.stringify(re)}).test(x))`);
    }
    await pick("ymd");
    await t.ok("remembered in the settings", `JSON.parse(localStorage.getItem('unimsg.settings')).dateFormat==='ymd'`);
    await pick("system");
    await t.ok("system default restores the original text", `JSON.stringify(${seps})===${JSON.stringify(JSON.stringify(before))}`);
  }),
];
