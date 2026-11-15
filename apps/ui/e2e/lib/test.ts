import type { Page } from "./harness.ts";

export interface TestDef {
  name: string;
  fn: (t: Page) => Promise<void>;
  /** ms for the whole test (default 60s) */
  timeout?: number;
  /** a script to run before the page's own code (e.g. stub Notification, preset localStorage) */
  init?: string;
  file?: string;
}

/** Declare a test. Each test gets a brand-new browser context (empty storage) and is expected to call t.open() itself. */
export function test(name: string, fn: TestDef["fn"], opts: { timeout?: number; init?: string } = {}): TestDef {
  return { name, fn, ...opts };
}

/** init script: records Notification calls in window.__notes and grants permission; auto-confirm() */
export const NOTIFY_INIT = `window.__notes=[];window.Notification=function(t,o){window.__notes.push([t,(o||{}).tag,(o||{}).body])};Notification.permission='granted';Notification.requestPermission=async()=>'granted';window.confirm=()=>true;try{localStorage.setItem('unimsg.settings',JSON.stringify({notifications:true}))}catch(e){}`;
/** init script: preset the UI settings stored in localStorage */
export const settingsInit = (s: object) => `try{localStorage.setItem('unimsg.settings',JSON.stringify(${JSON.stringify(s)}))}catch(e){}`;
