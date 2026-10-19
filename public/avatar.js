// 立ち絵を canvas に描き、呼吸・揺れ・感情リアクション・口パクをつける。
// 口パクは、指定された口の位置を肌色でなじませて隠し、その上に開いた口を描く方式。

const FALLBACK_SKIN = [246, 222, 208];

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.img = null;
    this.rig = { mouth: null, mouthSize: 0.06, motion: 1 };
    this.skin = FALLBACK_SKIN;
    this.rigging = false;

    this.mouth = { value: 0, target: 0, holdUntil: 0 };
    this.flapping = false;
    this.flapUntil = 0;
    this.nextFlapAt = 0;

    this.emotion = { name: "normal", since: 0 };
    this.layout = { x: 0, y: 0, w: 0, h: 0 };
    this.last = performance.now();
    this.phase = Math.random() * 10;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  async setImage(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    this.img = img;
    this.layoutImage();
    this.sampleSkin();
  }

  setRig(rig) {
    const mouthChanged = JSON.stringify(rig.mouth) !== JSON.stringify(this.rig.mouth);
    this.rig = { ...this.rig, ...rig };
    if (mouthChanged || rig.mouthSize !== undefined) this.sampleSkin();
  }

  setEmotion(name) {
    this.emotion = { name, since: performance.now() };
  }

  /** 1文字ぶん口を開ける（openness: 0〜1, holdMs: 開いている時間） */
  pulse(openness, holdMs) {
    this.mouth.target = openness;
    this.mouth.holdUntil = performance.now() + holdMs;
  }

  /** 読み上げ中など、ランダムに口をパクパクさせる */
  setFlapping(on) {
    this.flapping = on;
  }

  flapFor(ms) {
    this.flapUntil = performance.now() + ms;
  }

  /** 画面上の座標 → 画像内の相対座標（0〜1） */
  toImageCoords(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const { x, y, w, h } = this.layout;
    return { x: (clientX - r.left - x) / w, y: (clientY - r.top - y) / h };
  }

  // ---------- internals ----------

  resize() {
    const parent = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = parent.clientWidth;
    this.cssH = parent.clientHeight;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.dpr = dpr;
    this.layoutImage();
  }

  layoutImage() {
    if (!this.img) return;
    const W = this.cssW, H = this.cssH;
    const s = Math.min((W * 0.94) / this.img.naturalWidth, (H * 0.94) / this.img.naturalHeight);
    const w = this.img.naturalWidth * s;
    const h = this.img.naturalHeight * s;
    // 足元（画像の下端）をステージ下端に合わせる
    this.layout = { x: (W - w) / 2, y: H - h, w, h };
  }

  sampleSkin() {
    if (!this.img || !this.rig.mouth) return;
    const iw = this.img.naturalWidth, ih = this.img.naturalHeight;
    const c = document.createElement("canvas");
    c.width = iw;
    c.height = ih;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(this.img, 0, 0);
    const mx = this.rig.mouth.x * iw, my = this.rig.mouth.y * ih;
    const mw = this.rig.mouthSize * iw;
    const samples = [];
    // 口の左右・少し下の頬やあごのあたりから色を拾う
    for (const [dx, dy] of [[-0.9, 0], [0.9, 0], [-0.7, 0.5], [0.7, 0.5], [0, 0.8], [-1.1, -0.3], [1.1, -0.3]]) {
      const px = Math.round(mx + dx * mw), py = Math.round(my + dy * mw);
      if (px < 0 || py < 0 || px >= iw || py >= ih) continue;
      const d = cx.getImageData(px, py, 1, 1).data;
      if (d[3] > 200) samples.push([d[0], d[1], d[2]]);
    }
    if (!samples.length) {
      this.skin = FALLBACK_SKIN;
      return;
    }
    const median = (i) => samples.map((s) => s[i]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    this.skin = [median(0), median(1), median(2)];
  }

  updateMouth(now, dt) {
    const m = this.mouth;
    const flapping = this.flapping || now < this.flapUntil;
    if (flapping) {
      if (now >= this.nextFlapAt) {
        const r = Math.random();
        m.target = r < 0.15 ? 0.05 : 0.3 + Math.random() * 0.7;
        this.nextFlapAt = now + 70 + Math.random() * 90;
      }
    } else if (now > m.holdUntil) {
      m.target = 0;
    }
    m.value += (m.target - m.value) * Math.min(1, dt * 28);
  }

  emotionPose(now) {
    const t = (now - this.emotion.since) / 1000;
    const pose = { dx: 0, dy: 0, rot: 0, sy: 0 };
    switch (this.emotion.name) {
      case "happy":
        if (t < 0.9) pose.dy = -Math.abs(Math.sin(t * Math.PI * 2.2)) * 12 * (1 - t / 0.9);
        break;
      case "surprised":
        if (t < 0.6) {
          pose.dy = -Math.sin(Math.min(1, t / 0.6) * Math.PI) * 20;
          pose.sy = 0.02 * (1 - t / 0.6);
        }
        break;
      case "angry":
        if (t < 0.5) pose.dx = Math.sin(t * 60) * 4 * (1 - t / 0.5);
        break;
      case "sad": {
        const k = Math.min(1, t / 0.6) * (t < 4 ? 1 : Math.max(0, 1 - (t - 4)));
        pose.sy = -0.015 * k;
        pose.dy = 4 * k;
        break;
      }
      case "shy": {
        const k = Math.min(1, t / 0.5) * (t < 3.5 ? 1 : Math.max(0, 1 - (t - 3.5)));
        pose.rot = 0.035 * k;
        break;
      }
    }
    return pose;
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.updateMouth(now, dt);
    this.draw(now);
    requestAnimationFrame((t) => this.frame(t));
  }

  draw(now) {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.img) return;

    const { x, y, w, h } = this.layout;
    const t = now / 1000 + this.phase;
    const motion = this.rigging ? 0 : this.rig.motion;
    const breath = Math.sin((t * Math.PI * 2) / 3.6);
    const sway = Math.sin((t * Math.PI * 2) / 7.3) + 0.3 * Math.sin((t * Math.PI * 2) / 2.9);
    const pose = this.rigging ? { dx: 0, dy: 0, rot: 0, sy: 0 } : this.emotionPose(now);
    const talk = this.mouth.value;

    const sx = 1 - breath * 0.003 * motion;
    const sy = 1 + breath * 0.009 * motion + pose.sy + talk * 0.004 * motion;
    const rot = sway * 0.008 * motion + pose.rot;

    ctx.save();
    // 足元中央を支点にして、呼吸・揺れ・リアクションをかける
    ctx.translate(x + w / 2 + pose.dx, y + h + pose.dy);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.translate(-w / 2, -h);
    ctx.drawImage(this.img, 0, 0, w, h);
    if (this.rig.mouth) this.drawMouth(w, h);
    ctx.restore();
  }

  drawMouth(w, h) {
    const { ctx } = this;
    const cx = this.rig.mouth.x * w;
    const cy = this.rig.mouth.y * h;
    const mw = this.rig.mouthSize * w;
    const o = this.mouth.value;

    if (this.rigging) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#e2558f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, mw * 0.6, mw * 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (o < 0.04) return;

    const [r, g, b] = this.skin;
    // 1) 元の口を肌色でぼかして隠す
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.7);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, mw * 0.8);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.6, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, mw * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2) 開いた口を描く（あごが下がるように下方向へ開く）
    const rx = mw * 0.5 * (0.7 + 0.3 * o);
    const ry = Math.max(0.6, mw * 0.4 * o);
    const my = cy + ry * 0.35;
    const dark = `rgb(${Math.round(r * 0.3)},${Math.round(g * 0.1)},${Math.round(b * 0.15)})`;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, my, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.clip();
    if (o > 0.25) {
      ctx.fillStyle = "#d46a78";
      ctx.beginPath();
      ctx.ellipse(cx, my + ry * 0.75, rx * 0.7, ry * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.strokeStyle = `rgba(${Math.round(r * 0.35)},${Math.round(g * 0.2)},${Math.round(b * 0.2)},0.7)`;
    ctx.lineWidth = Math.max(1, mw * 0.05);
    ctx.beginPath();
    ctx.ellipse(cx, my, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------- 文字 → 口の開き具合 ----------

const VOWEL_ROWS = {
  1.0: "あかさたなはまやらわがざだばぱぁゃゎアカサタナハマヤラワガザダバパァャヮaA",
  0.35: "いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィiI",
  0.45: "うくすつぬふむゆるぐずづぶぷぅゅウクスツヌフムユルグズヅブプゥュuU",
  0.7: "えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェeE",
  0.8: "おこそとのほもよろをごぞどぼぽぉょオコソトノホモヨロヲゴゾドボポォョoO",
  0.12: "んンっッー〜",
};
const OPENNESS = new Map();
for (const [open, chars] of Object.entries(VOWEL_ROWS)) {
  for (const ch of chars) OPENNESS.set(ch, Number(open));
}

export function mouthOpenFor(ch) {
  if (OPENNESS.has(ch)) return OPENNESS.get(ch);
  if (/[\s、。，．,.!?！？…・「」『』（）()\[\]【】]/.test(ch)) return 0;
  if (/[a-z]/i.test(ch)) return 0.3 + Math.random() * 0.3;
  return 0.45 + Math.random() * 0.45; // 漢字など
}
