// "Discord wants to check that you are human": renders the provider's hCaptcha challenge (generic "captcha" login prompt) and returns the solved token.
// BEST-EFFORT: the site key belongs to the provider (Discord's is configured for discord.com), so hCaptcha may refuse to render it on this origin.
// The widget script is loaded only when this modal opens. Nothing is stored; the token goes straight to the provider via submitLogin.
import { useEffect, useRef, useState } from "react";
import { core } from "./util";
import type { LoginPrompt } from "./types";
import { Modal } from "./Modals";

type CaptchaPrompt = Extract<LoginPrompt, { kind: "captcha" }>;
const SCRIPT = "https://js.hcaptcha.com/1/api.js?render=explicit";

let loading: Promise<any> | undefined;
function loadHcaptcha(): Promise<any> {
  const w = window as any;
  if (w.hcaptcha) return Promise.resolve(w.hcaptcha);
  loading ??= new Promise((ok, bad) => {
    const s = document.createElement("script"); s.src = SCRIPT; s.async = true; s.defer = true;
    s.onload = () => (w.hcaptcha ? ok(w.hcaptcha) : bad(new Error("hcaptcha missing")));
    s.onerror = () => { loading = undefined; s.remove(); bad(new Error("hcaptcha blocked")); };
    document.head.appendChild(s);
  });
  return loading;
}

/** e2e / demo only: `?mock` with window.__mockCaptcha shows a stub button instead of the real widget. */
const stubbed = () => new URLSearchParams(location.search).has("mock") && !!(window as any).__mockCaptcha;

export function CaptchaModal({ prompt, onClose }: { prompt: CaptchaPrompt; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const answered = useRef(false);

  const answer = async (token: string) => {
    if (answered.current) return; answered.current = true; setBusy(true);
    try { await core.call("submitLogin", { accountId: prompt.accountId, promptId: prompt.promptId, values: { token } }); } catch { /* the chat action reports its own error */ }
    onClose();
  };

  useEffect(() => {
    if (stubbed()) { setReady(true); return; }
    let dead = false, wid: string | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
    const fail = (why: string) => { if (!dead && !answered.current) setProblem(why); };
    loadHcaptcha().then((hc) => {
      if (dead || !box.current) return;
      try {
        const light = document.documentElement.dataset.theme === "light" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: light)").matches);
        wid = hc.render(box.current, {
          sitekey: prompt.sitekey, theme: light ? "light" : "dark", size: "normal",
          callback: (t: string) => { if (t) void answer(t); },
          "expired-callback": () => fail("The check expired. Please solve it again."),
          "error-callback": () => fail("The check could not be shown here. Discord's captcha may only work on discord.com."),
        });
        if (prompt.rqdata) hc.setData(wid, { rqdata: prompt.rqdata });
        setReady(true);
        watchdog = setTimeout(() => { if (!box.current?.querySelector("iframe")) fail("The check did not appear. Discord's captcha may only work on discord.com."); }, 12000);
      } catch { fail("The check could not be shown here. Discord's captcha may only work on discord.com."); }
    }, () => fail("The captcha could not be loaded (blocked or offline)."));
    return () => { dead = true; clearTimeout(watchdog); try { if (wid !== undefined) (window as any).hcaptcha?.remove?.(wid); } catch { /* ignore */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.promptId]);

  const cancel = () => { void answer(""); };
  return (
    <Modal title={prompt.title} onClose={cancel}>
      {prompt.hint && <p className="hint">{prompt.hint}</p>}
      {stubbed()
        ? <div className="captchabox"><button type="button" className="primary" data-testid="captcha-stub" disabled={busy} onClick={() => void answer("stub-captcha-token")}>I am human (stub)</button></div>
        : <div className="captchabox" ref={box} aria-busy={!ready && !problem} />}
      {!ready && !problem && !stubbed() && <p className="hint center">Loading the check…</p>}
      {problem && <div className="error" role="alert">{problem}</div>}
      <p className="hint">This check is best-effort: Discord configures it for its own website and may refuse it elsewhere.{prompt.link && <> If it does not work, <a href={prompt.link.href} target="_blank" rel="noreferrer noopener">{prompt.link.label}</a>, solve it there and try again.</>}</p>
      <button type="button" data-testid="captcha-cancel" disabled={busy} onClick={cancel}>Cancel</button>
    </Modal>
  );
}
