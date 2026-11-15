import { useEffect, useRef, useState } from "react";
import type { Attachment } from "./types";
import { fmtBytes, fmtDuration, sq } from "./util";
import { AlertCircle, Download, Maximize2, Pause, Play, Volume2, VolumeX } from "./icons";

/**
 * A video message: a square, cropped tile like a picture (no browser controls). Click / Space / Enter plays inline,
 * a thin progress bar, a mute toggle and an expand button appear on hover and while playing; double-click or the expand
 * button opens the uncropped Lightbox. Only one video plays at a time. A clip the browser can't decode shows a download state.
 */
let current: HTMLVideoElement | undefined;

export function VideoPlayer({ a, size, url, failed, onLoad, onExpand }: { a: Attachment; size: number; url?: string; failed?: boolean; onLoad: () => Promise<{ url: string } | undefined>; onExpand: (url: string, at: number) => void }) {
  const el = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState((a.durationMs ?? 0) / 1000);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState(false); // the browser can't decode it (e.g. QuickTime / unsupported codec)
  const [ready, setReady] = useState(false); // first frame available
  const want = useRef(false);
  const label = a.name ?? "video";

  const toggle = async () => {
    if (!url) { setBusy(true); want.current = true; await onLoad().finally(() => setBusy(false)); return; }
    const v = el.current; if (!v) return;
    if (!v.paused) { v.pause(); return; }
    v.play().catch(() => {});
  };
  useEffect(() => { if (url && want.current) { want.current = false; setTimeout(() => void el.current?.play().catch(() => {}), 0); } }, [url]);
  useEffect(() => () => { if (current === el.current) current = undefined; }, []);

  const onPlay = () => {
    const v = el.current!;
    if (current && current !== v) current.pause();
    current = v; setPlaying(true);
    document.querySelectorAll<HTMLMediaElement>("audio").forEach((x) => x.pause()); // voice messages stop too
  };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const v = el.current; const total = v && isFinite(v.duration) ? v.duration : dur; if (!v || !total) return;
    const r = e.currentTarget.getBoundingClientRect(); v.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * total; setPos(v.currentTime);
  };
  const seekKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const v = el.current; if (!v || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault(); e.stopPropagation(); v.currentTime = Math.max(0, v.currentTime + (e.key === "ArrowRight" ? 5 : -5)); setPos(v.currentTime);
  };
  const expand = () => { const v = el.current; v?.pause(); if (url) onExpand(url, v?.currentTime ?? 0); };
  const download = () => { if (!url) return; const x = document.createElement("a"); x.href = url; x.download = a.name ?? "video"; x.click(); };
  const stop = (f: () => void) => (e: React.SyntheticEvent) => { e.stopPropagation(); f(); };

  const box = sq(size);
  if (broken) // the clip can't be decoded here: say so and offer the file
    return (
      <div className="vidwrap vidbroken" style={box} role="group" aria-label={`Video ${label}: cannot play here`}>
        {a.thumbnailDataUrl && <img src={a.thumbnailDataUrl} alt="" />}
        <span className="vidmsg"><AlertCircle size={20} /><b>Cannot play here</b><small>{a.mime}{a.size ? ` · ${fmtBytes(a.size)}` : ""}</small>
          <button className="secondary" onClick={download}><Download size={14} /> Download</button></span>
      </div>);

  const shown = playing || pos > 0.3 ? pos : dur;
  const frac = dur ? Math.min(1, pos / dur) : 0;
  return (
    <div className={"vidwrap" + (playing ? " playing" : "") + (url && !ready ? " loading" : "")} style={box} data-video={a.id}>
      {url
        ? <video ref={el} className="vidtag" src={url + "#t=0.1"} poster={a.thumbnailDataUrl} preload="metadata" playsInline muted={muted} aria-hidden
            onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (isFinite(d) && d > 0) setDur(d); }} onLoadedData={() => setReady(true)}
            onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)} onPlay={onPlay} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0); }}
            onError={() => setBroken(true)} />
        : a.thumbnailDataUrl && <img className="vidtag" src={a.thumbnailDataUrl} alt="" />}
      <div className="vidhit" role="button" tabIndex={0} aria-label={failed ? `Retry loading video ${label}` : `${playing ? "Pause" : "Play"} video ${label}`} aria-pressed={playing} title={label}
        onClick={() => void toggle()} onDoubleClick={() => (url ? expand() : undefined)}
        onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); void toggle(); } else if (e.key.toLowerCase() === "f") expand(); }}>
        <span className="vidplay">{failed ? <AlertCircle size={26} /> : busy ? <i className="spinner" /> : playing ? <Pause size={26} /> : <Play size={26} />}</span>
        {failed && <span className="vidfail">Failed to load. Click to retry</span>}
      </div>
      <span className="viddur" aria-label="Duration">{dur || playing || pos > 0.3 ? fmtDuration(shown) : a.size ? fmtBytes(a.size) : "Video"}{!url && a.size && dur ? ` · ${fmtBytes(a.size)}` : ""}</span>
      {url && <div className="vidctrls">
        <div className="vidbar" role="slider" tabIndex={0} aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(pos)} onClick={seek} onKeyDown={seekKey}><i style={{ width: frac * 100 + "%" }} /></div>
        <button className="vidbtn" aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"} onClick={stop(() => setMuted(!muted))}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
        <button className="vidbtn" aria-label="Expand video" title="Expand" onClick={stop(expand)}><Maximize2 size={15} /></button>
      </div>}
    </div>);
}
