// Renders the tree from markup.ts as React elements (never HTML strings). Text leaves keep the usual handling:
// custom emoji tokens and bare URLs through Linkified.
import { Fragment, useState, type ReactNode } from "react";
import { parse, type Block, type Dialect, type Inline } from "./markup";
import { Linkified } from "./util";

const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

/** A masked link names its destination next to it (the text can say anything), and asks first when its text looks like a different address. */
function MaskedLink({ href, children, text }: { href: string; children: ReactNode; text: string }) {
  const host = hostOf(href);
  const shown = /^\s*(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(text)?.[1]?.toLowerCase();
  const deceptive = !!shown && shown !== host.toLowerCase() && !host.toLowerCase().endsWith("." + shown);
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer noopener" title={href} className="masked" data-masked
        onClick={(e) => { if (deceptive && !window.confirm(`This link says “${shown}”, but it goes to:\n\n${href}\n\nOpen it?`)) e.preventDefault(); }}>{children}</a>
      {host && <span className="linkdest" aria-hidden> ({host})</span>}
    </>
  );
}

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={"spoiler" + (open ? " open" : "")} data-spoiler role={open ? undefined : "button"} tabIndex={open ? undefined : 0} aria-label={open ? undefined : "Spoiler, tap to show"}
      onClick={(e) => { if (!open) { e.preventDefault(); e.stopPropagation(); setOpen(true); } }}
      onKeyDown={(e) => { if (!open && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpen(true); } }}>
      <span aria-hidden={!open}>{children}</span>
    </span>
  );
}

const textOf = (c: Inline[]): string => c.map((x) => (typeof x === "string" ? x : x.t === "code" ? x.v : x.t === "url" ? x.href : textOf(x.c))).join("");

function Inlines({ c, emojiScope, big }: { c: Inline[]; emojiScope?: string; big?: boolean }) {
  return <>{c.map((x, i) => {
    if (typeof x === "string") return <Linkified key={i} text={x} emojiScope={emojiScope} big={!!big} />;
    switch (x.t) {
      case "b": return <strong key={i}><Inlines c={x.c} emojiScope={emojiScope} /></strong>;
      case "i": return <em key={i}><Inlines c={x.c} emojiScope={emojiScope} /></em>;
      case "u": return <u key={i}><Inlines c={x.c} emojiScope={emojiScope} /></u>;
      case "s": return <s key={i}><Inlines c={x.c} emojiScope={emojiScope} /></s>;
      case "spoiler": return <Spoiler key={i}><Inlines c={x.c} emojiScope={emojiScope} /></Spoiler>;
      case "code": return <code key={i} className="icode">{x.v}</code>;
      case "url": return <a key={i} href={x.href} target="_blank" rel="noreferrer noopener">{x.href}</a>;
      case "link": return <MaskedLink key={i} href={x.href} text={textOf(x.c)}><Inlines c={x.c} emojiScope={emojiScope} /></MaskedLink>;
    }
  })}</>;
}

function Blocks({ bs, emojiScope, big }: { bs: Block[]; emojiScope?: string; big?: boolean }) {
  return <>{bs.map((b, i) => {
    switch (b.t) {
      // the last paragraph stays inline, so the time / ticks after it can float into its last line
      case "p": return i === bs.length - 1 ? <span key={i} className="mdp"><Inlines c={b.c} emojiScope={emojiScope} big={big} /></span> : <div key={i} className="mdp"><Inlines c={b.c} emojiScope={emojiScope} big={big} /></div>;
      case "h": return <div key={i} className={"mdh h" + b.level} role="heading" aria-level={b.level}><Inlines c={b.c} emojiScope={emojiScope} /></div>;
      case "sub": return <div key={i} className="mdsub"><Inlines c={b.c} emojiScope={emojiScope} /></div>;
      case "pre": return <pre key={i} className="codeblock" data-lang={b.lang}><code>{b.v}</code></pre>;
      case "quote": return <div key={i} className="mdquote"><Blocks bs={b.c} emojiScope={emojiScope} /></div>;
      case "list": return (
        <div key={i} className="mdlist" role="list">{b.items.map((it, j) => (
          <div key={j} role="listitem" className="mdli" style={{ paddingInlineStart: `${1.4 + it.indent * 1.2}em` }}>
            <span className="mdmark" aria-hidden style={{ insetInlineStart: `${it.indent * 1.2}em` }}>{it.marker}</span><Inlines c={it.c} emojiScope={emojiScope} />
          </div>))}
        </div>);
    }
  })}</>;
}

/** Message text in the network's markup dialect. `trailing` (time / ticks) goes into the last block so it can float into its last line. */
export function RichText({ text, dialect, emojiScope, trailing }: { text: string; dialect: Dialect; emojiScope?: string; trailing?: ReactNode }) {
  const bs = parse(text, dialect);
  const lone = !!emojiScope && /^\s*:[A-Za-z0-9_+-]{2,64}:\s*$/.test(text);
  return <><Blocks bs={bs} emojiScope={emojiScope} big={lone} />{trailing && <Fragment>{trailing}</Fragment>}</>;
}
