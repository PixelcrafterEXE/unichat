import { useEffect, useRef, useState } from "react";
import type { Attachment } from "./types";
import { fmtDuration, toBars, waveformOf, webmOpusToOgg } from "./util";
import { Mic, Pause, Play, SendHorizontal, Trash2 } from "./icons";

let current: HTMLAudioElement | undefined; // only one voice message plays at a time
const SPEEDS = [1, 1.5, 2];

/** A voice message / audio clip: play button, waveform you can click to seek, elapsed/total time and playback speed. */
export function VoicePlayer({ a, url, onLoad, failed }: { a: Attachment; url?: string; onLoad: () => Promise<{ url: string } | undefined>; failed?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState((a.durationMs ?? 0) / 1000);
  const [speed, setSpeed] = useState(1);
  const [bars, setBars] = useState<number[]>(() => (a.waveform?.length ? toBars(a.waveform, 40) : Array(40).fill(18)));
  const [busy, setBusy] = useState(false);
  const want = useRef(false);

  useEffect(() => { // no waveform from the sender: derive it from the audio once it is loaded
    if (!url || a.waveform?.length) return;
    let live = true; waveformOf(url, 40).then((b) => live && setBars(b), () => {});
    return () => { live = false; };
  }, [url, a.waveform]);

  const play = async () => {
    if (!url) { setBusy(true); want.current = true; await onLoad().finally(() => setBusy(false)); return; }
    const el = audio.current; if (!el) return;
    if (!el.paused) { el.pause(); return; }
    if (current && current !== el) current.pause();
    current = el; el.playbackRate = speed; el.play().catch(() => {});
  };
  useEffect(() => { if (url && want.current) { want.current = false; setTimeout(() => void play(), 0); } }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audio.current; const total = el && isFinite(el.duration) ? el.duration : dur; if (!el || !total) return;
    const r = e.currentTarget.getBoundingClientRect(); el.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * total;
    setPos(el.currentTime);
  };
  const cycle = () => { const n = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!; setSpeed(n); if (audio.current) audio.current.playbackRate = n; };
  const frac = dur ? Math.min(1, pos / dur) : 0;
  const shown = playing || pos > 0 ? pos : dur;

  return (
    <div className={"voice" + (playing ? " playing" : "")}>
      <button className="vplay" onClick={play} disabled={busy} aria-label={playing ? "Pause" : "Play"} title={failed ? "Retry" : playing ? "Pause" : "Play"}>
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <div className="vbody">
        <div className="vbars" onClick={seek} role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(pos)}>
          {bars.map((h, i) => <i key={i} className={(i + 0.5) / bars.length <= frac ? "on" : ""} style={{ height: `${Math.max(12, h)}%` }} />)}
        </div>
        <div className="vmeta"><span>{failed ? "Could not load" : busy ? "Loading…" : fmtDuration(shown)}</span>
          {a.kind === "audio" && a.name && <span className="vname">{a.name}</span>}</div>
      </div>
      <button className="vspeed" onClick={cycle} title="Playback speed">{speed}×</button>
      {url && <audio ref={audio} src={url} preload="metadata"
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) setDur(d); }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPos(0); }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)} />}
    </div>
  );
}

export interface VoiceClip { blob: Blob; mime: string; name: string; durationMs: number; waveform: number[] }

/** Composer replacement while recording: live level bars, timer, discard and send. Starts the microphone on mount. */
export function VoiceRecorder({ onCancel, onSend }: { onCancel: () => void; onSend: (c: VoiceClip) => Promise<void> | void }) {
  const [secs, setSecs] = useState(0);
  const [live, setLive] = useState<number[]>(Array(32).fill(0));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const st = useRef<{ mr: MediaRecorder; chunks: Blob[]; stream: MediaStream; levels: number[]; t0: number; ctx?: AudioContext; stop: () => void; cancelled: boolean }>();

  useEffect(() => {
    let dead = false;
    (async () => {
      let stream: MediaStream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { if (!dead) setErr("Microphone not available or permission denied."); return; }
      if (dead) { stream.getTracks().forEach((t) => t.stop()); return; }
      // Prefer Ogg/Opus (what WhatsApp and Signal expect); Chromium only does WebM/Opus, which we remux when sending.
      const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported?.(m));
      const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const chunks: Blob[] = []; const levels: number[] = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      let timer: ReturnType<typeof setInterval> | undefined; let ctx: AudioContext | undefined;
      try {
        ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        timer = setInterval(() => {
          an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
          levels.push(peak); setLive((l) => [...l.slice(1), peak]);
        }, 80);
      } catch { /* no level meter: recording still works */ }
      const stop = () => { if (timer) clearInterval(timer); ctx?.close().catch(() => {}); stream.getTracks().forEach((t) => t.stop()); };
      st.current = { mr, chunks, stream, levels, t0: Date.now(), ctx, stop, cancelled: false };
      mr.start(250);
    })();
    const tick = setInterval(() => st.current && setSecs(Math.round((Date.now() - st.current.t0) / 1000)), 250);
    return () => { dead = true; clearInterval(tick); const s = st.current; if (s) { s.cancelled = true; s.stop(); if (s.mr.state !== "inactive") s.mr.stop(); } };
  }, []);

  const finish = async () => {
    const s = st.current; if (!s || busy) return; setBusy(true);
    const stopped = new Promise<void>((ok) => { s.mr.onstop = () => ok(); });
    if (s.mr.state !== "inactive") s.mr.stop(); await stopped; s.stop(); s.cancelled = true;
    try {
      const raw = new Blob(s.chunks, { type: s.mr.mimeType || "audio/webm" });
      const ms = Date.now() - s.t0;
      let blob = raw, durationMs = ms, mime = raw.type.split(";")[0] ?? "audio/webm", name = "voice-message.webm";
      if (/webm/.test(raw.type)) {
        try { const o = await webmOpusToOgg(raw); blob = o.blob; durationMs = o.durationMs; mime = "audio/ogg; codecs=opus"; name = "voice-message.ogg"; } catch { /* send the WebM as it is */ }
      } else if (/ogg/.test(raw.type)) { mime = "audio/ogg; codecs=opus"; name = "voice-message.ogg"; }
      else if (/mp4/.test(raw.type)) name = "voice-message.m4a";
      await onSend({ blob, mime, name, durationMs, waveform: toBars(s.levels, 64) });
    } catch (e: any) { setErr(e?.message ?? "Could not send the voice message."); setBusy(false); }
  };

  if (err) return <div className="composer recording"><Mic size={18} /> <span style={{ flex: 1 }}>{err}</span><button className="secondary" onClick={onCancel}>Close</button></div>;
  return (
    <div className="composer recording">
      <button className="icon" onClick={onCancel} title="Discard" disabled={busy}><Trash2 size={18} /></button>
      <span className="recdot" /><span className="rectime">{fmtDuration(secs)}</span>
      <div className="recbars">{live.map((v, i) => <i key={i} style={{ height: `${Math.max(8, Math.round(v * 140))}%` }} />)}</div>
      <button className="sendbtn" onClick={finish} disabled={busy || secs < 1} title="Send voice message"><SendHorizontal size={18} /></button>
    </div>);
}
