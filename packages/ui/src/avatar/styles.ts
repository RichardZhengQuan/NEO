/**
 * Avatar and picker styles. Shipped with the component (React hoists and
 * de-duplicates the <style href> tag), so apps don't import anything.
 *
 * Animation layers (see neo-avatar.tsx):
 *   loops – breathing, blinking eyelids, robot eye glow (keyframes)
 *   poses – leaning in, tilting per state (transitions, so state changes
 *           ease in instead of jumping)
 * Everything pivots near the bottom edge, where the portrait is cut off, so
 * motion never opens a gap there. All motion stops for prefers-reduced-motion
 * and for animated={false}; the state still shows as a still pose.
 */
export const AVATAR_CSS = `
.neo-av{display:inline-block;position:relative;flex-shrink:0;overflow:hidden;line-height:0;vertical-align:middle;isolation:isolate}
.neo-av>svg,.neo-av>img{display:block;width:100%;height:100%}
.neo-av>img{object-fit:cover}
.neo-av--circle{border-radius:50%}
.neo-av--squircle{border-radius:30%}
.neo-av--square{border-radius:0}
.neo-av-emoji{display:flex;align-items:center;justify-content:center;width:100%;height:100%;line-height:1}

.neo-av-bob{transform-box:view-box;transform-origin:50px 100px;animation:neo-av-breathe 4.6s ease-in-out infinite}
.neo-av-head,.neo-av-nod{transform-box:view-box;transform-origin:50px 96px}
.neo-av-head{transition:transform .6s cubic-bezier(.34,1.3,.64,1)}
.neo-av-lid{transform-box:fill-box;transform-origin:50% 0%;transform:scaleY(0);animation:neo-av-blink 5.2s infinite}
/* The mouth is drawn in its own frame with (0, 0) on the painted smile, so it opens from there. */
.neo-av-mouth-open{opacity:0;transform-box:view-box;transform-origin:0 0}
.neo-av-mouth--grow{transform:scale(.15)}
.neo-av-flap{opacity:0}
.neo-av-halo{opacity:.2;animation:neo-av-glow 2.8s ease-in-out infinite}
.neo-av-thought{opacity:0;transform-box:fill-box;transform-origin:0% 100%;transform:scale(.4);transition:opacity .25s ease,transform .45s cubic-bezier(.34,1.56,.64,1)}
.neo-av-dot{transform-box:fill-box;transform-origin:center}
.neo-av-alert{opacity:0;transform-box:fill-box;transform-origin:0% 100%;transform:scale(.3);transition:opacity .2s ease,transform .4s cubic-bezier(.34,1.7,.64,1)}

/* listening: leans in, alert marks */
.neo-av[data-state=listening] .neo-av-head{transform:rotate(2.5deg) scale(1.035)}
.neo-av[data-state=listening] .neo-av-alert{opacity:1;transform:scale(1);animation:neo-av-ping 1.6s ease-in-out .4s infinite}
.neo-av[data-state=listening] .neo-av-halo{animation-duration:1.3s}

/* thinking: tilts the other way beside a thought bubble */
.neo-av[data-state=thinking] .neo-av-head{transform:rotate(-2.5deg)}
.neo-av[data-state=thinking] .neo-av-thought{opacity:1;transform:scale(1)}
.neo-av[data-state=thinking] .neo-av-dot{animation:neo-av-dot 1.2s ease-in-out infinite}
.neo-av[data-state=thinking] .neo-av-dot2{animation-delay:.16s}
.neo-av[data-state=thinking] .neo-av-dot3{animation-delay:.32s}
.neo-av[data-state=thinking] .neo-av-halo{animation-duration:.8s}

/* speaking: the mouth opens from the painted smile, small nods; the robot's eyes flicker */
.neo-av[data-state=speaking] .neo-av-nod{animation:neo-av-nod 2.6s ease-in-out infinite}
.neo-av[data-state=speaking] .neo-av-mouth-open{opacity:1}
.neo-av[data-state=speaking] .neo-av-mouth--grow{animation:neo-av-jaw-grow 1.15s ease-in-out infinite}
/* lip flaps: closed, open, half, open, closed, half, open, half, closed, half (0.12s each) */
.neo-av[data-state=speaking] .neo-av-flap-half{animation:neo-av-flap-half 1.2s step-end infinite}
.neo-av[data-state=speaking] .neo-av-flap-open{animation:neo-av-flap-open 1.2s step-end infinite}
.neo-av[data-state=speaking] .neo-av-halo{animation:neo-av-glow .42s ease-in-out infinite alternate}

@keyframes neo-av-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.012)}}
@keyframes neo-av-blink{0%,91%,97%,100%{transform:scaleY(0)}93%,95%{transform:scaleY(1)}}
@keyframes neo-av-nod{0%,100%{transform:rotate(0)}30%{transform:rotate(-.8deg)}70%{transform:rotate(.6deg)}}
@keyframes neo-av-flap-half{0%,30%,60%,80%{opacity:0}20%,50%,70%,90%{opacity:1}}
@keyframes neo-av-flap-open{0%,20%,40%,70%{opacity:0}10%,30%,60%{opacity:1}}
@keyframes neo-av-jaw-grow{0%,100%{transform:scale(.15)}16%{transform:scale(1)}32%{transform:scale(.4)}50%{transform:scale(.9)}66%{transform:scale(.2)}82%{transform:scale(.75)}}
@keyframes neo-av-glow{0%,100%{opacity:.08}50%{opacity:.4}}
@keyframes neo-av-ping{0%,100%{transform:scale(1)}50%{transform:scale(.82)}}
@keyframes neo-av-dot{0%,55%,100%{transform:translateY(0);opacity:.4}25%{transform:translateY(-1.8px);opacity:1}}

.neo-av--still *{animation:none!important}
@media (prefers-reduced-motion:reduce){.neo-av *{animation:none!important;transition:none!important}}

/* ── picker ── */
.neo-avp{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start;font-size:14px;color:var(--neo-text,#111118)}
.neo-avp-stage{display:flex;flex-direction:column;align-items:center;gap:10px;margin:0 auto}
.neo-avp-states{display:flex;flex-wrap:wrap;justify-content:center;gap:4px;max-width:200px}
.neo-avp-chip{font:inherit;font-size:12px;line-height:1.2;padding:4px 10px;border-radius:999px;border:1px solid var(--neo-border,#E4E4EF);background:transparent;color:var(--neo-text-muted,#6B6B85);cursor:pointer}
.neo-avp-chip:hover{color:var(--neo-text,#111118)}
.neo-avp-chip[aria-pressed=true]{background:var(--neo-text,#111118);border-color:var(--neo-text,#111118);color:var(--neo-surface,#FFFFFF)}
.neo-avp-controls{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:14px}
.neo-avp-label{font-size:12px;font-weight:500;color:var(--neo-text-muted,#6B6B85);margin:0 0 6px}
.neo-avp-kinds{display:flex;flex-wrap:wrap;gap:6px}
.neo-avp-kind{font:inherit;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:5px 5px 4px;border-radius:16px;border:2px solid transparent;background:transparent;color:var(--neo-text-muted,#6B6B85);cursor:pointer}
.neo-avp-kind:hover{background:var(--neo-surface-2,#F0F0F8)}
.neo-avp-kind[aria-checked=true]{border-color:var(--neo-accent,#7C5CFF);color:var(--neo-text,#111118)}
.neo-avp-swatches{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.neo-avp-swatch{position:relative;width:26px;height:26px;padding:0;border:0;border-radius:50%;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(128,128,140,.35)}
.neo-avp-swatch[aria-checked=true],.neo-avp-custom[data-selected=true]{box-shadow:inset 0 0 0 1px rgba(128,128,140,.35),0 0 0 2px var(--neo-surface,#FFFFFF),0 0 0 4px var(--neo-accent,#7C5CFF)}
.neo-avp-custom{background:conic-gradient(#FF6B6B,#FFD93D,#6BCB77,#4D96FF,#9B5DE5,#FF6B6B)}
.neo-avp-custom input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:0;padding:0}
.neo-avp-custom-mark{position:absolute;inset:7px;border-radius:50%;background:var(--neo-surface,#FFFFFF);pointer-events:none}
.neo-avp-chip:focus-visible,.neo-avp-kind:focus-visible,.neo-avp-swatch:focus-visible,.neo-avp-custom:focus-within{outline:2px solid var(--neo-accent,#7C5CFF);outline-offset:2px}
.neo-avp--compact{flex-direction:column;align-items:stretch;gap:14px}
.neo-avp--compact .neo-avp-controls{flex:none;gap:10px}
.neo-avp--compact .neo-avp-kinds{justify-content:space-between}
.neo-avp--compact .neo-avp-swatches{gap:6px}
.neo-avp--compact .neo-avp-swatch{width:24px;height:24px}
`;
