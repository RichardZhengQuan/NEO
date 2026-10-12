/*
 * NEO homepage behaviour, ported from the first-run guide without a build step:
 * the avatar orbit (packages/ui/src/avatar/use-avatar-orbit.ts, orbit-geometry.ts),
 * the figure's ink glitch (neo-figure.tsx), the wordmark fit (PrintWordmark.tsx),
 * the typed terminal line (TerminalLine.tsx), and an English / 中文 switch.
 */
(() => {
  'use strict';

  const KINDS = ['robot', 'cat', 'dog', 'boy', 'girl'];
  const STRINGS = {
    en: {
      'meta.title': 'NEO · The personal AI that grows with you',
      'meta.description': 'NEO is an open-source personal AI that grows with you: one continuous timeline instead of chats, memory that works like yours, and a personality it learns from you.',
      'lang.next': '中文',
      'lang.nextLabel': '切换到中文',
      'lang.nextCode': 'zh-CN',
      'nav.docs': 'Docs',
      'nav.github': 'GitHub',
      'orbit.label': "Choose NEO's look",
      'avatar.robot': 'Robot',
      'avatar.cat': 'Cat',
      'avatar.dog': 'Dog',
      'avatar.boy': 'Boy',
      'avatar.girl': 'Girl',
      'card.label': 'Open source · MIT',
      'card.terminal': "hi, i'm neo_",
      'card.title': 'An open-source personal AI that grows with you.',
      'pillar.1.title': 'No chats, just one story',
      'pillar.1.text': 'NEO keeps one continuous timeline with you, like a person would, and picks up where you left off. Go off the record any time.',
      'pillar.2.title': 'Memory that works like yours',
      'pillar.2.text': 'It remembers what matters on its own, is reminded of related things, and lets the rest fade.',
      'pillar.3.title': 'A personality that grows',
      'pillar.3.text': 'No name or tone settings. NEO learns how you like to talk by talking with you. You only choose its face.',
      'cta.start': 'Get started',
      'cta.memory': 'How memory works',
    },
    zh: {
      'meta.title': 'NEO · 和你一起成长的个人 AI',
      'meta.description': 'NEO 是一个和你一起成长的开源个人 AI：没有对话列表，只有一条连续的时间线；记忆像人一样运作；性格从和你的相处中长出来。',
      'lang.next': 'EN',
      'lang.nextLabel': 'Switch to English',
      'lang.nextCode': 'en',
      'nav.docs': '文档',
      'nav.github': 'GitHub',
      'orbit.label': '选择 NEO 的样子',
      'avatar.robot': '机器人',
      'avatar.cat': '猫咪',
      'avatar.dog': '小狗',
      'avatar.boy': '男孩',
      'avatar.girl': '女孩',
      'card.label': '开源 · MIT',
      'card.terminal': '你好，我是 neo_',
      'card.title': '一个和你一起成长的开源个人 AI。',
      'pillar.1.title': '没有对话列表，只有一段共同的经历',
      'pillar.1.text': 'NEO 像人一样，和你只有一条连续的时间线，总能接着上次聊下去。不想被记住的话，随时切到不留记录。',
      'pillar.2.title': '像你一样的记忆',
      'pillar.2.text': '它会自己记住重要的事，被相关的事情提醒，让不重要的慢慢淡忘。',
      'pillar.3.title': '性格是长出来的',
      'pillar.3.text': '没有名字和语气设置。NEO 在和你的相处中学会你喜欢的说话方式。你只需要选它的样子。',
      'cta.start': '开始使用',
      'cta.memory': '记忆如何运作',
    },
  };

  const home = document.querySelector('.home');
  const stage = home.querySelector('.stage');
  const card = home.querySelector('.card');
  const frame = home.querySelector('.figure-frame');
  const figure = home.querySelector('.figure');
  const colorImage = figure.querySelector('.figure-color');
  const inkImage = figure.querySelector('.figure-ink');
  const orbit = home.querySelector('.orbit');
  const nodes = Array.from(orbit.querySelectorAll('.orbit-node'));
  const terminalText = home.querySelector('.terminal-text');
  const avatarName = home.querySelector('.hud-avatar-name');
  const langButton = home.querySelector('.lang');

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;
  // The page opens on the girl; the orbit starts with her portrait at the front.
  let kind = 'girl';
  let lang = 'en';

  const figureUrl = (name, ink) => `assets/figures/${name}${ink ? '-ink' : ''}.webp`;
  const t = (key) => STRINGS[lang][key] ?? STRINGS.en[key] ?? key;

  /* ── Wordmark: the viewBox hugs the painted capitals ─────────────────── */
  function fitWordmark() {
    const glyph = document.getElementById('wordmark-glyph');
    if (typeof glyph?.getBBox !== 'function') return;
    const box = glyph.getBBox();
    if (!(box.width > 0 && box.height > 0)) return;
    let top = box.y;
    let height = box.height;
    // SVG text boxes include the font's full glyph cell; canvas ink metrics don't.
    const context = document.createElement('canvas').getContext('2d');
    if (context) {
      const font = getComputedStyle(glyph);
      context.font = `${font.fontStyle || 'normal'} ${font.fontWeight || '900'} ${font.fontSize || '100px'} ${font.fontFamily || 'Impact, sans-serif'}`;
      const ink = context.measureText('NEO');
      const inkHeight = ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent;
      if (Number.isFinite(inkHeight) && inkHeight > 0) {
        top = -ink.actualBoundingBoxAscent;
        height = inkHeight;
      }
    }
    glyph.ownerSVGElement.setAttribute('viewBox', `${box.x - 1} ${top - 1} ${box.width + 2} ${height + 2}`);
  }

  /* ── Terminal line: backspace the old command, then type the new one ─── */
  let typingTimer;
  function typeLine(text, { from = terminalText.textContent } = {}) {
    clearInterval(typingTimer);
    if (reduced) { terminalText.textContent = text; return; }
    const type = () => {
      let count = 0;
      terminalText.textContent = '';
      typingTimer = setInterval(() => {
        count += 1;
        terminalText.textContent = text.slice(0, count);
        if (count >= text.length) clearInterval(typingTimer);
      }, 45);
    };
    if (!from) { type(); return; }
    let tick = 0;
    typingTimer = setInterval(() => {
      tick += 1;
      terminalText.textContent = from.slice(0, Math.ceil(from.length * (1 - tick / 6)));
      if (tick === 6) { clearInterval(typingTimer); type(); }
    }, 15);
  }

  /* ── Figure: colour artwork with occasional ink glitch bursts ────────── */
  const BURST_MS = 480;
  const glitch = { ready: false, pending: false, next: undefined, end: undefined };
  function clearGlitch() {
    clearTimeout(glitch.next);
    clearTimeout(glitch.end);
    glitch.next = glitch.end = undefined;
    delete figure.dataset.glitch;
  }
  function scheduleGlitch() {
    clearTimeout(glitch.next);
    if (!reduced) glitch.next = setTimeout(startGlitch, 4000 + Math.random() * 4000);
  }
  function startGlitch() {
    if (reduced) return;
    if (!glitch.ready) { glitch.pending = !document.hidden; return; }
    if (document.hidden || glitch.end !== undefined) return;
    glitch.pending = false;
    figure.dataset.glitch = 'true';
    glitch.end = setTimeout(() => { glitch.end = undefined; delete figure.dataset.glitch; }, BURST_MS);
    scheduleGlitch();
  }
  inkImage.addEventListener('load', () => {
    if (!inkImage.getAttribute('src')) return;
    glitch.ready = true;
    if (glitch.pending) startGlitch();
  });
  function loadInk(name) {
    glitch.ready = false;
    inkImage.src = figureUrl(name, true);
    figure.style.setProperty('--ink', `url("${figureUrl(name, true)}")`);
  }
  if (colorImage.complete) loadInk(kind);
  else colorImage.addEventListener('load', () => loadInk(kind), { once: true });
  frame.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') startGlitch(); });
  frame.addEventListener('pointerdown', startGlitch);

  function preload(name) {
    const image = new Image();
    image.src = figureUrl(name);
  }

  function setKind(next) {
    if (next === kind || !KINDS.includes(next)) return;
    kind = next;
    nodes.forEach((node) => {
      const selected = node.dataset.kind === next;
      node.setAttribute('aria-checked', String(selected));
      node.tabIndex = selected ? 0 : -1;
    });
    avatarName.textContent = next.toUpperCase();
    // Swap only once the new artwork is decoded, so the stage never flashes empty.
    const image = new Image();
    image.src = figureUrl(next);
    const swap = () => {
      if (kind !== next) return;
      home.dataset.kind = next;
      figure.dataset.kind = next;
      colorImage.src = image.src;
      clearGlitch();
      glitch.pending = true;
      loadInk(next);
      scheduleMeasure();
    };
    (image.decode ? image.decode() : Promise.resolve()).then(swap, swap);
  }

  /* ── Orbit geometry (orbit-geometry.ts) ──────────────────────────────── */
  const usable = (rect) => !!rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;

  function orbitGeometry({ frame: frameRect, area, viewport, clearance }) {
    const bounds = usable(area) ? area : usable(viewport) ? viewport : null;
    if (!bounds) return null;
    const figureRect = usable(frameRect) ? frameRect : frameRect ? null : bounds;
    if (!figureRect) return null;
    const mobile = bounds.width < 900;
    const radius = mobile ? 28 : 32;
    const { width, height } = figureRect;
    const x = figureRect.left - bounds.left + width / 2;
    const top = figureRect.top - bounds.top;
    const cardRect = !mobile && usable(clearance) ? clearance : null;

    const availableRadius = (y, ry, targetRadius) => {
      // Include the complete keyboard outline, even when a rear target is lifted.
      const padding = targetRadius + 12;
      let available = Math.min(x, bounds.width - x) - padding;
      if (cardRect) {
        const cardTop = cardRect.top - bounds.top;
        const cardBottom = cardTop + cardRect.height;
        const gap = targetRadius + 6 + 24;
        const low = Math.max(-1, (cardTop - gap - y) / ry);
        const high = Math.min(1, (cardBottom + gap - y) / ry);
        if (low < high) {
          const cardOnRight = cardRect.left + cardRect.width / 2 > bounds.left + x;
          const cardSpace = cardOnRight ? cardRect.left - bounds.left - x : x - (cardRect.left + cardRect.width - bounds.left);
          // Near the top and bottom of the arc the ellipse never reaches its full width.
          const closestToCenter = low > 0 ? low : high < 0 ? high : 0;
          const horizontalReach = Math.sqrt(1 - closestToCenter * closestToCenter);
          available = Math.min(available, (cardSpace - gap) / horizontalReach);
        }
      }
      return Math.max(0, available);
    };

    const ry = width * 0.2;
    const y = top + height * 0.48;
    const rx = Math.min(width * 0.825, availableRadius(y, ry, radius));
    if (rx <= 0) return null;
    return {
      bounds,
      portrait: { x, y, rx, ry },
      portraitRadius: radius,
      focusedPortraitMinY: cardRect ? top + height * 0.42 + radius + 6 + 2 : null,
    };
  }

  /* ── Orbit motion (use-avatar-orbit.ts) ──────────────────────────────── */
  const TAU = Math.PI * 2;
  const FRONT = Math.PI / 2;
  const SELECT_MS = 600;
  const TOUCH_MS = 4000;
  const angle = (value) => ((value % TAU) + TAU) % TAU;

  // Reduced motion lays the portraits evenly along the front arc instead.
  function frontArc(ellipse, count) {
    const samples = Array.from({ length: 181 }, (_, i) => i * Math.PI / 180);
    const distances = [0];
    samples.slice(1).forEach((theta, index) => {
      const before = samples[index];
      distances.push(distances[index] + Math.hypot(ellipse.rx * (Math.cos(theta) - Math.cos(before)), ellipse.ry * (Math.sin(theta) - Math.sin(before))));
    });
    return Array.from({ length: count }, (_, index) => {
      const target = distances[180] * index / Math.max(1, count - 1);
      const upper = Math.max(1, distances.findIndex((distance) => distance >= target));
      const lower = upper - 1;
      const span = distances[upper] - distances[lower];
      return samples[lower] + (samples[upper] - samples[lower]) * (span ? (target - distances[lower]) / span : 0);
    });
  }

  let phase = FRONT - KINDS.indexOf(kind) * TAU / KINDS.length;
  let turn = null;
  let ellipse = { x: 0, y: 0, rx: 0, ry: 0 };
  let staticAngles = [];
  let frameId = null;
  let lastTime = null;
  let speed = 1;
  let stageHover = false;
  let hovered = null;
  let focused = null;
  let keyboardFocus = true;
  let touchUntil = 0;
  let touchTimer;
  let hiddenAt = document.hidden ? performance.now() : null;
  let focusedPortraitMinY = null;
  let hasGeometry = false;
  let originX = 0;
  let originY = 0;
  let geometryFrame = null;

  const paused = () => reduced || stageHover || hovered !== null || (focused !== null && keyboardFocus) || performance.now() < touchUntil || document.hidden;

  function paint() {
    if (!hasGeometry) return;
    orbit.dataset.orbitMotion = reduced ? 'reduced' : 'running';
    nodes.forEach((node, index) => {
      const theta = reduced ? staticAngles[index] ?? FRONT : angle(phase + index * TAU / nodes.length);
      const showFocused = keyboardFocus && focused === node;
      const front = Math.sin(theta) >= 0 || showFocused;
      const showHovered = hovered === node;
      const x = originX + ellipse.x + ellipse.rx * Math.cos(theta);
      let y = ellipse.y + ellipse.ry * Math.sin(theta);
      if (showFocused && focusedPortraitMinY !== null) {
        // A raised rear portrait passes below the face rather than over it.
        y = Math.max(focusedPortraitMinY, ellipse.y + ellipse.ry * Math.abs(Math.sin(theta)));
      }
      node.style.transform = `translate3d(${x.toFixed(2)}px, ${(originY + y).toFixed(2)}px, 0) translate(-50%, -50%) scale(${front ? 1 : showHovered ? 0.9 : 0.8})`;
      node.style.opacity = front || showHovered ? '1' : '.6';
      node.style.zIndex = showFocused ? '4' : front ? '3' : '1';
    });
  }

  function measure() {
    const geometry = orbitGeometry({
      area: stage.getBoundingClientRect(),
      frame: frame.getBoundingClientRect(),
      clearance: card.getBoundingClientRect(),
      viewport: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
    });
    if (!geometry) {
      if (!hasGeometry) orbit.style.visibility = 'hidden';
      return;
    }
    hasGeometry = true;
    orbit.style.visibility = '';
    const origin = orbit.getBoundingClientRect();
    originX = geometry.bounds.left - origin.left;
    originY = geometry.bounds.top - origin.top;
    focusedPortraitMinY = geometry.focusedPortraitMinY;
    ellipse = geometry.portrait;
    staticAngles = frontArc(ellipse, nodes.length);
    for (const half of ['back', 'front']) {
      const start = half === 'back' ? -1 : 1;
      orbit.querySelector(`.orbit-path--${half} path`).setAttribute('d', `M ${originX + ellipse.x + start * ellipse.rx} ${originY + ellipse.y} A ${ellipse.rx} ${ellipse.ry} 0 0 1 ${originX + ellipse.x - start * ellipse.rx} ${originY + ellipse.y}`);
    }
    const radius = geometry.portraitRadius;
    const hit = orbit.querySelector('.orbit-area');
    const left = originX + ellipse.x - ellipse.rx - radius - 8;
    const upper = originY + ellipse.y - ellipse.ry - radius - 8;
    const lower = originY + ellipse.y + ellipse.ry + radius + 8;
    hit.style.transform = `translate3d(${left}px, ${upper}px, 0)`;
    hit.style.width = `${ellipse.rx * 2 + (radius + 8) * 2}px`;
    hit.style.height = `${Math.max(0, lower - upper)}px`;
    paint();
  }

  function scheduleMeasure() {
    if (geometryFrame !== null) return;
    geometryFrame = requestAnimationFrame(() => { geometryFrame = null; measure(); });
  }

  function tick(now) {
    if (document.hidden || reduced) { frameId = null; return; }
    const elapsed = lastTime === null ? 0 : Math.max(0, now - lastTime);
    lastTime = now;
    if (paused()) speed = 0;
    const nextSpeed = paused() ? 0 : 1 - (1 - speed) * Math.exp(-elapsed / 300);
    if (turn) {
      const progress = Math.min(1, Math.max(0, (now - turn.started) / SELECT_MS));
      const ease = progress * progress * (3 - 2 * progress);
      phase = turn.from + (turn.to - turn.from) * ease;
      if (progress === 1) turn = null;
    } else {
      // One revolution every 30 seconds, easing back in after a pause.
      phase += elapsed * (speed + nextSpeed) / 2 * TAU / 30000;
    }
    speed = nextSpeed;
    paint();
    frameId = requestAnimationFrame(tick);
  }

  function startOrbit() {
    if (!reduced && !document.hidden && frameId === null) {
      lastTime = null;
      frameId = requestAnimationFrame(tick);
    }
  }

  // Turn the chosen portrait to the front of the orbit.
  function selectOrbit(index) {
    if (reduced) return;
    const target = FRONT - index * TAU / nodes.length;
    const delta = angle(target - phase + Math.PI) - Math.PI;
    turn = { from: phase, to: phase + delta, started: performance.now() };
  }

  function touch() {
    keyboardFocus = false;
    hovered = null;
    touchUntil = performance.now() + TOUCH_MS;
    speed = 0;
    clearTimeout(touchTimer);
    touchTimer = setTimeout(paint, TOUCH_MS);
    paint();
  }

  // Hovering the figure or the orbit's band pauses it; so does a touch, for a while.
  stage.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch') { stageHover = true; speed = 0; paint(); } });
  stage.addEventListener('pointerleave', () => { stageHover = false; hovered = null; paint(); });
  stage.addEventListener('pointerdown', (event) => { keyboardFocus = false; if (event.pointerType === 'touch') touch(); else paint(); });
  stage.addEventListener('touchstart', touch, { passive: true });
  orbit.addEventListener('focusin', (event) => {
    focused = event.target.closest('.orbit-node');
    if (focused && keyboardFocus) speed = 0;
    paint();
  });
  orbit.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    focused = next && orbit.contains(next) ? next.closest('.orbit-node') : null;
    paint();
  });
  document.addEventListener('keydown', () => { keyboardFocus = true; if (focused) speed = 0; paint(); });

  nodes.forEach((node, index) => {
    node.querySelector('.orbit-visual').style.setProperty('--stagger', `${index * 40}ms`);
    node.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      hovered = node;
      speed = 0;
      preload(node.dataset.kind);
      paint();
    });
    node.addEventListener('pointerleave', () => { if (hovered === node) hovered = null; paint(); });
    node.addEventListener('click', () => { selectOrbit(index); setKind(node.dataset.kind); });
    node.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      let nextIndex;
      if (step !== undefined) nextIndex = (index + step + nodes.length) % nodes.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = nodes.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectOrbit(nextIndex);
      setKind(nodes[nextIndex].dataset.kind);
      nodes[nextIndex].focus();
    });
  });

  document.addEventListener('visibilitychange', () => {
    const now = performance.now();
    if (document.hidden && hiddenAt === null) hiddenAt = now;
    else if (!document.hidden && hiddenAt !== null) {
      if (turn) turn.started += now - Math.max(hiddenAt, turn.started);
      hiddenAt = null;
    }
    lastTime = null;
    speed = 0;
    if (document.hidden && frameId !== null) { cancelAnimationFrame(frameId); frameId = null; }
    else startOrbit();
    paint();
    clearGlitch();
    if (!document.hidden) { if (glitch.pending) startGlitch(); else scheduleGlitch(); }
  });

  function applyMotion() {
    reduced = motionQuery.matches;
    home.dataset.motion = reduced ? 'off' : 'on';
    if (reduced) { clearGlitch(); clearInterval(typingTimer); terminalText.textContent = t('card.terminal'); }
    else { scheduleGlitch(); startOrbit(); }
    paint();
  }
  motionQuery.addEventListener('change', applyMotion);

  /* ── Language ────────────────────────────────────────────────────────── */
  function applyLanguage(next, { animate }) {
    lang = next;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('meta.title');
    document.querySelector('meta[name="description"]').setAttribute('content', t('meta.description'));
    home.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
    home.querySelectorAll('[data-i18n-label]').forEach((element) => {
      element.setAttribute('aria-label', t(element.dataset.i18nLabel));
      element.title = t(element.dataset.i18nLabel);
    });
    langButton.textContent = t('lang.next');
    langButton.setAttribute('aria-label', t('lang.nextLabel'));
    langButton.lang = t('lang.nextCode');
    if (animate) typeLine(t('card.terminal'));
    else terminalText.textContent = t('card.terminal');
    // The card's height can change with the language, and the orbit clears the card.
    scheduleMeasure();
  }

  function initialLanguage() {
    try {
      const stored = localStorage.getItem('neo-site-lang');
      if (stored === 'en' || stored === 'zh') return stored;
    } catch { /* Storage can be unavailable; fall back to the browser language. */ }
    return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  }

  langButton.addEventListener('click', () => {
    const next = lang === 'en' ? 'zh' : 'en';
    try { localStorage.setItem('neo-site-lang', next); } catch { /* Not persisted. */ }
    applyLanguage(next, { animate: true });
  });

  /* ── Start ───────────────────────────────────────────────────────────── */
  applyLanguage(initialLanguage(), { animate: false });
  applyMotion();
  if (!reduced) typeLine(t('card.terminal'), { from: '' });
  fitWordmark();
  document.fonts?.ready.then(() => { fitWordmark(); scheduleMeasure(); });
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(measure);
    [stage, frame, card].forEach((element) => observer.observe(element));
  }
  window.addEventListener('resize', measure);
  measure();
  startOrbit();
})();
