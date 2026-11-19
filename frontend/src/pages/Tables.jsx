import Icon from "../lib/icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, cap, elapsed, fmtDT, fmtTime, money } from "../lib/api";
import { navigate } from "../lib/store";
import { useAuth, useFetch, useShell, useUI } from "../lib/store";
import { Badge, Empty, ErrorBox, Field, Loading, Modal, Tabs } from "../lib/ui";
import { ReceiptModal } from "../components/Receipt";
import { QR_BRAND, downloadQrCard } from "../lib/qrcard";
import { buildTableSvg, PHASES, T3D_CSS, tableShape } from "../lib/tableScene";
import "../styles/table-qr.css";

// what the floor plan shows (the server sends "phase"; older servers only send "status")
const ST = ["available", "occupied", "served", "bill", "reserved", "cleaning", "out_of_service"];
const phaseOf = (t) => t.phase || t.status;
const labelOf = (k) => (PHASES[k] ? PHASES[k].label : cap(k));

function FloorTile({ t, on, onClick, i }) {
  const phase = phaseOf(t);
  const seats = Math.min(t.capacity || 4, 10);
  const guests = ["occupied", "served", "bill"].includes(phase) ? t.seated || t.order?.guests || 0 : 0;
  const svg = useMemo(
    () => buildTableSvg({ uid: `t${t.id}`, shape: tableShape(t.capacity, t.id), seats, guests, phase, label: t.name }),
    [t.id, t.capacity, t.name, seats, guests, phase],
  );
  const name = /^\d+$/.test(String(t.name)) ? `Table ${t.name}` : t.name;
  return (
    <button className={`t3d ${phase} ${on ? "on" : ""}`} style={{ "--i": Math.min(i, 30) }} onClick={onClick} title={`${name} - ${labelOf(phase)}`}>
      <span className="t3d-art" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="t3d-name">{name}</span>
      <span className={`t3d-pill ${phase}`}>
        <i />
        {labelOf(phase)}
        {guests > 0 ? ` (${guests})` : ""}
      </span>
      <span className="t3d-sub">
        {["occupied", "served", "bill"].includes(phase) && t.order && (
          <>
            {elapsed(t.status_since)} · <b>{money(t.order.total)}</b>
          </>
        )}
        {phase === "occupied" && !t.order && "QR scanned · choosing"}
        {phase === "reserved" && `${t.reserved_for || "Reserved"}${t.reserved_at ? ` · ${fmtTime(t.reserved_at)}` : ""}`}
        {phase === "cleaning" && "Est. 15 min"}
        {phase === "out_of_service" && "Not in use"}
        {phase === "available" && `${t.capacity} seats`}
        {guests > seats && ` · seats ${seats}`}
      </span>
    </button>
  );
}

// ============================ 3D ROOM ENGINE (three.js) ============================
const PHASE = {
  available: { ring: "#34d399", pill: "#16a34a", soft: true },
  occupied: { ring: "#2f6bff", pill: "#2563eb" },
  served: { ring: "#ff9d1c", pill: "#d97706" },
  bill: { ring: "#ff3030", pill: "#dc2626" },
  reserved: { ring: "#a78bfa", pill: "#7c3aed" },
  cleaning: { ring: "#22d3ee", pill: "#0d9488" },
  out_of_service: { ring: "#6b7280", pill: "#4b5563" },
};
const look = (p) => PHASE[p] || PHASE.available;

const SHIRTS = ["#e03e3e", "#2b8be6", "#f08c00", "#8e44e8", "#12a67c", "#f2c200", "#e64980", "#3b5bdb"];
const SKINS = ["#f3cfae", "#e6b184", "#c98e5d", "#8d5a3b", "#f6dcc2"];
const HAIRS = ["#1b1b1f", "#4a2c17", "#7a4a21", "#b8702c", "#2b2b33"];
const FOODS = ["#e11d48", "#84cc16", "#f59e0b", "#fb923c", "#a3e635"];
const SCREENS = ["#60a5fa", "#38bdf8", "#818cf8", "#34d399"];
const TAN = "#e29a52"; // chairs of round tables
const OLIVE = "#8c9a2a"; // chairs of square tables
const SOFA_GREEN = "#2f6f3e";
const LEAF_GREENS = ["#2f8f46", "#3aa356", "#43b25f", "#2c8a43"];
const LEAF_LIME = ["#a3c93a", "#8cbb2e", "#c6d84a", "#6fa82a"];
const pick = (arr, n) => arr[Math.abs(Math.floor(n)) % arr.length];

function seeded(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ sizes */

const WALL_H = 3.4;
const PITCH = (56 * Math.PI) / 180; // camera looks down at 56 degrees
const FOV = 28;

// sizes in metres. a/b = half width/depth of the glow ring (incl. chairs), p = ring "squareness"
function dimsOf(shape, n) {
  if (shape === "sofa") {
    const nb = Math.min(3, Math.ceil(n / 2));
    const sw = Math.max(2.0, nb * 0.78 + 0.35);
    return { kind: "sofa", hx: sw * 0.36, hz: 0.4, tz: 0.2, sw, nb, a: sw / 2 + 0.62, b: 1.4, p: 3 };
  }
  if (shape === "long") {
    const hx = (1.1 + n * 0.14) / 2;
    const hz = 0.45;
    return { kind: "box", hx, hz, tz: 0, a: hx + 0.75, b: hz + 0.72, p: 3 };
  }
  if (shape === "square") {
    const h = 0.5;
    return { kind: "box", hx: h, hz: h, tz: 0, a: h + 0.78, b: h + 0.78, p: 3 };
  }
  const R = 0.46 + Math.min(n, 8) * 0.035;
  return { kind: "round", R, hx: R, hz: R, tz: 0, a: R + 0.68, b: R + 0.68, p: 2 };
}

// chair positions around the table (x,z relative to the table centre). o = unit vector pointing away from the table
function seatsOf(d, shape, n) {
  const out = [];
  if (shape === "sofa") {
    const nf = n - d.nb;
    const xs = (cnt, j, span) => (cnt === 1 ? 0 : (((j + 0.5) / cnt) * 2 - 1) * span);
    for (let j = 0; j < Math.max(d.nb, nf); j++) {
      if (j < d.nb) out.push({ x: xs(d.nb, j, d.sw / 2 - 0.42), z: -0.62, ox: 0, oz: -1, ext: d.hz, sofa: true });
      if (j < nf) out.push({ x: xs(nf, j, d.hx * 0.7), z: d.tz + d.hz + 0.34, ox: 0, oz: 1, ext: d.hz });
    }
    return out;
  }
  if (shape === "long") {
    const top = Math.ceil(n / 2);
    const bot = n - top;
    const xs = (cnt, j) => (cnt === 1 ? 0 : (((j + 0.5) / cnt) * 2 - 1) * d.hx * 0.8);
    for (let j = 0; j < Math.max(top, bot); j++) {
      if (j < top) out.push({ x: xs(top, j), z: -(d.hz + 0.34), ox: 0, oz: -1, ext: d.hz });
      if (j < bot) out.push({ x: xs(bot, j), z: d.hz + 0.34, ox: 0, oz: 1, ext: d.hz });
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const th = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const c = Math.cos(th);
    const s = Math.sin(th);
    if (shape === "round") {
      out.push({ x: c * (d.R + 0.34), z: s * (d.R + 0.34), ox: c, oz: s, ext: d.R });
    } else {
      const m = Math.max(Math.abs(c), Math.abs(s)) || 1;
      const k = (d.hx + 0.34) / m;
      const ox = Math.abs(c) >= Math.abs(s) ? Math.sign(c) || 1 : 0;
      const oz = ox === 0 ? Math.sign(s) || 1 : 0;
      out.push({ x: c * k, z: s * k, ox, oz, ext: d.hx });
    }
  }
  return out;
}

// which chairs get a guest: spread around the table, not all on one side
function spread(n, g) {
  const k = Math.min(g, n);
  const idx = [];
  for (let i = 0; i < k; i++) idx.push(Math.min(n - 1, Math.floor((i * n) / k)));
  return idx;
}

// where every table stands in the room (every column / row is only as wide / deep as its biggest table)
function computeLayout(items, cafeName) {
  const n = items.length;
  const cols = n <= 4 ? Math.max(1, n) : n <= 6 ? 3 : n <= 12 ? 4 : 5;
  const rows = Math.max(1, Math.ceil(n / cols));
  const ds = items.map((it) => dimsOf(it.shape || "round", Math.max(1, Math.min(Number(it.capacity) || 4, 10))));
  const cw = new Array(cols).fill(0);
  const rb = new Array(rows).fill(0);
  ds.forEach((d, i) => {
    cw[i % cols] = Math.max(cw[i % cols], 2 * d.a);
    rb[Math.floor(i / cols)] = Math.max(rb[Math.floor(i / cols)], d.b);
  });
  const colW = cw.map((w) => Math.max(2.5, w) + 0.45);
  const LR = 2.6;
  const RR = 1.0;
  const W = LR + colW.reduce((s, v) => s + v, 0) + RR;
  const zs = [];
  rb.forEach((b, r) => zs.push(r === 0 ? 1.0 + b : zs[r - 1] + rb[r - 1] + b + 1.0));
  const D = zs[rows - 1] + rb[rows - 1] + 1.5;
  const colX = [];
  const colB = [];
  let acc = 0;
  colW.forEach((w) => {
    colX.push(-W / 2 + LR + acc + w / 2);
    acc += w;
    colB.push(-W / 2 + LR + acc);
  });
  const pos = items.map((it, i) => ({ x: colX[i % cols], z: -D / 2 + zs[Math.floor(i / cols)], d: ds[i] }));
  return { n, cols, rows, LR, RR, W, D, colB, rowZ: zs.map((z) => -D / 2 + z), pos, cafeName: cafeName || "" };
}

/* ----------------------------------------------------------------- engine */

function createRoom(THREE, RoundedBoxGeometry, host, onPick) {
  const cvHost = document.createElement("div");
  cvHost.className = "r3-cv";
  const labelLayer = document.createElement("div");
  labelLayer.className = "r3-labels";
  host.appendChild(cvHost);
  host.appendChild(labelLayer);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.cssText = "width:100%;height:100%;display:block";
  cvHost.appendChild(renderer.domElement);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 4);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0b1510");
  const camera = new THREE.PerspectiveCamera(FOV, 1.6, 0.1, 200);
  const target = new THREE.Vector3(0, 0.8, 0);

  /* ---------- shared resources (geometries, materials, textures) ---------- */
  const shared = new Map();
  const S = (key, make) => {
    if (!shared.has(key)) shared.set(key, make());
    return shared.get(key);
  };
  const G = (key, make) => S("g:" + key, make);
  const std = (color, o = {}) =>
    S(`m:${color}:${JSON.stringify(o)}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...o }));
  const basic = (color, o = {}) =>
    S(`b:${color}:${JSON.stringify(o)}`, () => new THREE.MeshBasicMaterial({ color, toneMapped: false, ...o }));

  const canvasTex = (key, w, h, draw, repeat) =>
    S("t:" + key, () => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      draw(c.getContext("2d"), w, h);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      if (repeat) {
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
      }
      return t;
    });

  const glowTex = () =>
    canvasTex("glow", 128, 128, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      gr.addColorStop(0, "rgba(255,255,255,1)");
      gr.addColorStop(0.45, "rgba(255,255,255,.35)");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    });

  const marbleTex = () =>
    canvasTex("marble", 256, 256, (g, w, h) => {
      const R = seeded(11);
      const gr = g.createRadialGradient(w * 0.35, h * 0.3, 8, w / 2, h / 2, w * 0.75);
      gr.addColorStop(0, "#32323b");
      gr.addColorStop(1, "#0c0c10");
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9; i++) {
        g.strokeStyle = `rgba(255,255,255,${0.05 + R() * 0.1})`;
        g.lineWidth = 1 + R() * 1.6;
        g.beginPath();
        g.moveTo(R() * w, R() * h);
        g.bezierCurveTo(R() * w, R() * h, R() * w, R() * h, R() * w, R() * h);
        g.stroke();
      }
    });

  const floorTex = (W, D) =>
    canvasTex(`floor:${Math.round(W)}x${Math.round(D)}`, 1024, 1024, (g, w, h) => {
      const R = seeded(5);
      g.fillStyle = "#6a3d1c";
      g.fillRect(0, 0, w, h);
      const pw = 64;
      for (let x = 0; x < w; x += pw) {
        g.fillStyle = `hsl(27,${46 + R() * 10}%,${29 + R() * 9}%)`;
        g.fillRect(x, 0, pw - 2, h);
        for (let i = 0; i < 70; i++) {
          g.strokeStyle = `rgba(0,0,0,${0.04 + R() * 0.08})`;
          g.lineWidth = 1;
          const gx = x + R() * pw;
          g.beginPath();
          g.moveTo(gx, 0);
          g.lineTo(gx + (R() - 0.5) * 6, h);
          g.stroke();
        }
        for (let y = R() * 200; y < h; y += 180 + R() * 160) {
          g.fillStyle = "rgba(0,0,0,.35)";
          g.fillRect(x, y, pw - 2, 2);
        }
        g.fillStyle = "rgba(0,0,0,.5)";
        g.fillRect(x + pw - 2, 0, 2, h);
      }
    }, true);

  const wallTex = () =>
    canvasTex("wall", 512, 512, (g, w, h) => {
      const R = seeded(9);
      const bw = 64;
      for (let x = 0; x < w; x += bw) {
        g.fillStyle = `hsl(22,${40 + R() * 8}%,${13 + R() * 7}%)`;
        g.fillRect(x, 0, bw, h);
        const gr = g.createLinearGradient(x, 0, x + bw, 0);
        gr.addColorStop(0, "rgba(255,255,255,.10)");
        gr.addColorStop(0.15, "rgba(255,255,255,0)");
        gr.addColorStop(1, "rgba(0,0,0,.25)");
        g.fillStyle = gr;
        g.fillRect(x, 0, bw, h);
        g.fillStyle = "rgba(0,0,0,.55)";
        g.fillRect(x, 0, 3, h);
      }
    }, true);

  const receiptTex = () =>
    canvasTex("receipt", 128, 160, (g, w, h) => {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#ef4444";
      g.fillRect(0, 0, w, 34);
      g.fillStyle = "#6b7280";
      for (let i = 0; i < 6; i++) g.fillRect(16, 52 + i * 18, i % 2 ? 70 : 96, 7);
    });

  // cyan badge with a broom + sparkles, floats above a table that is being cleaned
  const broomTex = () =>
    canvasTex("broom", 128, 128, (g, w, h) => {
      g.fillStyle = "rgba(8,40,48,.85)";
      g.beginPath();
      g.arc(64, 64, 58, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#22d3ee";
      g.lineWidth = 5;
      g.stroke();
      g.strokeStyle = "#e6fbff";
      g.lineWidth = 7;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(84, 30);
      g.lineTo(52, 76);
      g.stroke();
      g.fillStyle = "#e6fbff";
      g.beginPath();
      g.moveTo(40, 72);
      g.lineTo(62, 84);
      g.lineTo(46, 100);
      g.lineTo(32, 90);
      g.closePath();
      g.fill();
      g.fillStyle = "#67e8f9";
      for (const [x, y, r] of [[90, 78, 6], [100, 56, 4], [34, 46, 4]]) {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    });

  const signTex = (name) =>
    canvasTex("sign:" + name, 1024, 300, (g, w, h) => {
      g.fillStyle = "#1a110a";
      g.beginPath();
      if (g.roundRect) g.roundRect(6, 6, w - 12, h - 12, 34);
      else g.rect(6, 6, w - 12, h - 12);
      g.fill();
      g.strokeStyle = "#d9a93f";
      g.lineWidth = 9;
      g.stroke();
      g.strokeStyle = "rgba(217,169,63,.5)";
      g.lineWidth = 2;
      g.strokeRect(28, 28, w - 56, h - 56);
      g.strokeStyle = "#fdf2d6";
      g.lineWidth = 9;
      g.lineCap = "round";
      g.beginPath();
      g.arc(150, 140, 46, 0, Math.PI);
      g.moveTo(104, 140);
      g.lineTo(196, 140);
      g.stroke();
      g.beginPath();
      g.arc(204, 146, 18, -Math.PI / 2, Math.PI / 2);
      g.stroke();
      g.beginPath();
      g.moveTo(110, 200);
      g.lineTo(190, 200);
      g.stroke();
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(132, 112);
      g.quadraticCurveTo(122, 92, 134, 76);
      g.moveTo(166, 112);
      g.quadraticCurveTo(156, 92, 168, 76);
      g.stroke();
      let fs = 118;
      g.fillStyle = "#fdf2d6";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `800 ${fs}px Georgia, 'Times New Roman', serif`;
      while (g.measureText(name).width > w - 400 && fs > 36) {
        fs -= 4;
        g.font = `800 ${fs}px Georgia, 'Times New Roman', serif`;
      }
      g.fillText(name, 600, h * 0.46);
      g.fillStyle = "#d9a93f";
      g.font = "500 34px Arial, sans-serif";
      g.fillText("C A F É   &   R E S T A U R A N T", 600, h * 0.8);
    });

  // small wall board with 2-3 short lines ("Chai Adda", "Coffee Food Chill")
  const plaqueTex = (lines) =>
    canvasTex("plaque:" + lines.join("|"), 256, 320, (g, w, h) => {
      g.fillStyle = "#1a110a";
      g.fillRect(0, 0, w, h);
      g.strokeStyle = "#d9a93f";
      g.lineWidth = 8;
      g.strokeRect(10, 10, w - 20, h - 20);
      g.fillStyle = "#fdf2d6";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = "700 50px Georgia, 'Times New Roman', serif";
      const step = (h - 80) / lines.length;
      lines.forEach((t, i) => g.fillText(t, w / 2, 50 + step * (i + 0.5) + 10));
    });

  /* ---------- tiny helpers ---------- */
  const box = (w, h, d, r = 0.02) => G(`rb:${w}:${h}:${d}:${r}`, () => new RoundedBoxGeometry(w, h, d, 3, r));
  const cyl = (rt, rb, h, seg = 24) => G(`cy:${rt}:${rb}:${h}:${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg));
  const sph = (r, ws = 16, hs = 12) => G(`sp:${r}:${ws}:${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
  const cap = (r, len) => G(`ca:${r}:${len}`, () => new THREE.CapsuleGeometry(r, len, 4, 10));
  const cone = (r, h, seg = 6) => G(`co:${r}:${h}:${seg}`, () => new THREE.ConeGeometry(r, h, seg));
  const place = (m, x, y, z, shadow = true) => {
    m.position.set(x, y, z);
    if (shadow) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    return m;
  };
  const M = (geo, mat, x = 0, y = 0, z = 0, shadow = true) => place(new THREE.Mesh(geo, mat), x, y, z, shadow);

  /* ---------- plants ---------- */
  function addPlant(parent, x, y, z, s = 1, o = {}) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.add(M(cyl(0.2 * s, 0.14 * s, 0.32 * s, 18), std(o.pot || "#b4541d", { roughness: 0.8 }), 0, 0.16 * s, 0));
    g.add(M(cyl(0.18 * s, 0.18 * s, 0.02 * s, 18), std("#2b1a10"), 0, 0.325 * s, 0, false));
    const greens = o.greens || LEAF_GREENS;
    const N = 9;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const tilt = 0.3 + (i % 3) * 0.13;
      const h = (0.62 + (i % 3) * 0.14) * s;
      const leaf = new THREE.Mesh(cone(0.075 * s, h, 6), std(pick(greens, i), { roughness: 0.7 }));
      leaf.rotation.order = "YXZ";
      leaf.rotation.set(tilt, a, 0);
      const off = (h / 2) * Math.sin(tilt);
      leaf.position.set(Math.sin(a) * off, 0.33 * s + (h / 2) * Math.cos(tilt), Math.cos(a) * off);
      leaf.castShadow = true;
      g.add(leaf);
    }
    parent.add(g);
    return g;
  }

  // two small lime-green potted plants in the aisle between two columns of tables
  function addAislePlants(parent, x, z) {
    for (const dz of [-0.55, 0.55]) addPlant(parent, x, 0, z + dz, 0.85, { pot: "#4a2c17", greens: LEAF_LIME });
  }

  // hanging vines on the back wall (one InstancedMesh = very cheap)
  function addVines(parent, xs, zWall) {
    const per = 5 * 9;
    const im = new THREE.InstancedMesh(
      G("vine", () => new THREE.SphereGeometry(0.1, 8, 6)),
      S("vineMat", () => new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.85 })),
      xs.length * per,
    );
    const o = new THREE.Object3D();
    const R = seeded(77);
    let k = 0;
    for (const cx of xs) {
      for (let s = 0; s < 5; s++) {
        const sx = cx + (s - 2) * 0.22 + (R() - 0.5) * 0.1;
        const len = 0.9 + R() * 0.9;
        for (let i = 0; i < 9; i++) {
          o.position.set(sx + (R() - 0.5) * 0.08, WALL_H - 0.05 - (i / 8) * len, zWall + 0.07 + (R() - 0.5) * 0.06);
          const sc = 0.8 + R() * 0.7;
          o.scale.set(sc * 1.2, sc * 0.8, sc * 0.6);
          o.updateMatrix();
          im.setMatrixAt(k, o.matrix);
          im.setColorAt(k, new THREE.Color(pick(LEAF_GREENS.concat(LEAF_LIME), k)));
          k++;
        }
      }
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    parent.add(im);
  }

  /* ---------- the static room (floor, walls, counter, lamps, plants) ---------- */
  let staticGroup = null;
  let room = null;
  function buildStatic(L) {
    if (staticGroup) scene.remove(staticGroup);
    const W = L.W;
    const D = L.D;
    const sg = new THREE.Group();

    // floor
    const ft = floorTex(W, D);
    ft.repeat.set(Math.max(1, W / 4), Math.max(1, D / 4));
    ft.needsUpdate = true;
    const floor = new THREE.Mesh(G(`pl:${W}:${D}`, () => new THREE.PlaneGeometry(W, D)), S(`floorMat:${W}:${D}`, () => new THREE.MeshStandardMaterial({ map: ft, roughness: 0.5, metalness: 0.05 })));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    sg.add(floor);

    // walls
    const wt = wallTex();
    const wallMat = (len) =>
      S(`wallMat:${len}`, () => {
        const t = S(`t:wallrep:${len}`, () => {
          const c = wt.clone();
          c.repeat.set(len / 1.6, WALL_H / 1.6);
          c.needsUpdate = true;
          return c;
        });
        return new THREE.MeshStandardMaterial({ map: t, roughness: 0.75, metalness: 0.02 });
      });
    const back = new THREE.Mesh(G(`pl:${W}:${WALL_H}`, () => new THREE.PlaneGeometry(W, WALL_H)), wallMat(W));
    back.position.set(0, WALL_H / 2, -D / 2);
    back.receiveShadow = true;
    sg.add(back);
    const left = new THREE.Mesh(G(`pl:${D}:${WALL_H}`, () => new THREE.PlaneGeometry(D, WALL_H)), wallMat(D));
    left.position.set(-W / 2, WALL_H / 2, 0);
    left.rotation.y = Math.PI / 2;
    left.receiveShadow = true;
    sg.add(left);
    const right = new THREE.Mesh(G(`pl:${D}:${WALL_H}`, () => new THREE.PlaneGeometry(D, WALL_H)), wallMat(D));
    right.position.set(W / 2, WALL_H / 2, 0);
    right.rotation.y = -Math.PI / 2;
    right.receiveShadow = true;
    sg.add(right);
    // skirting boards + gold line
    sg.add(M(box(W, 0.22, 0.06, 0.01), std("#1b0f07"), 0, 0.11, -D / 2 + 0.03, false));
    sg.add(M(box(0.06, 0.22, D, 0.01), std("#1b0f07"), -W / 2 + 0.03, 0.11, 0, false));
    sg.add(M(box(0.06, 0.22, D, 0.01), std("#1b0f07"), W / 2 - 0.03, 0.11, 0, false));
    // warm LED strips along the top of the three walls (the orange rim in the reference)
    const led = basic("#ffa63d");
    sg.add(M(box(W, 0.05, 0.07, 0.01), led, 0, WALL_H - 0.12, -D / 2 + 0.05, false));
    sg.add(M(box(0.07, 0.05, D, 0.01), led, -W / 2 + 0.05, WALL_H - 0.12, 0, false));
    sg.add(M(box(0.07, 0.05, D, 0.01), led, W / 2 - 0.05, WALL_H - 0.12, 0, false));
    sg.add(M(box(W, 0.04, 0.05, 0.01), basic("#d9a93f"), 0, 0.26, -D / 2 + 0.04, false));

    // main sign (centre of the back wall) with a warm back-light, and two small boards
    const signX = 0;
    const back1 = new THREE.Mesh(G("signGlow", () => new THREE.PlaneGeometry(5.2, 1.7)), S("signGlowMat", () => new THREE.MeshBasicMaterial({ map: glowTex(), color: "#ff9a3c", transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
    back1.position.set(signX, 2.2, -D / 2 + 0.02);
    sg.add(back1);
    const sign = new THREE.Mesh(G("sign", () => new THREE.PlaneGeometry(3.9, 1.14)), S(`signMat:${L.cafeName}`, () => new THREE.MeshBasicMaterial({ map: signTex(L.cafeName || "Café"), toneMapped: false })));
    sign.position.set(signX, 2.2, -D / 2 + 0.03);
    sg.add(sign);
    const plaqueX = Math.max(3.6, W * 0.3);
    [["Chai", "Adda"], ["Coffee", "Food", "Chill"]].forEach((lines, i) => {
      const pq = new THREE.Mesh(G("plaque", () => new THREE.PlaneGeometry(0.95, 1.2)), S(`plaqueMat:${lines.join("|")}`, () => new THREE.MeshBasicMaterial({ map: plaqueTex(lines), toneMapped: false })));
      pq.position.set((i ? 1 : -1) * plaqueX, 2.15, -D / 2 + 0.03);
      sg.add(pq);
    });
    addVines(sg, [-plaqueX - 1.5, -plaqueX + 1.3, plaqueX - 1.3, plaqueX + 1.5, signX - 3.1, signX + 3.1], -D / 2);

    // bottle shelves on the left wall, next to the counter
    for (const sy of [1.5, 2.0, 2.5]) {
      sg.add(M(box(0.26, 0.05, 3.6, 0.01), std("#6b4423"), -W / 2 + 0.15, sy, -D / 2 + 2.5));
      for (let i = 0; i < 9; i++) {
        const col = pick(["#16a34a", "#f59e0b", "#e7d3b4", "#0ea5e9", "#a3e635", "#7c3aed"], i + Math.round(sy * 2));
        sg.add(M(cyl(0.05, 0.05, 0.3, 10), std(col, { roughness: 0.3 }), -W / 2 + 0.16, sy + 0.18, -D / 2 + 0.85 + i * 0.4));
      }
    }

    // pendant lamps (not in front of the sign)
    const lamps = Math.max(3, Math.round(W / 3.4));
    for (let i = 0; i < lamps; i++) {
      const lx = -W / 2 + (W * (i + 0.5)) / lamps;
      if (Math.abs(lx - signX) < 2.6) continue;
      const lz = -D / 2 + 0.9;
      sg.add(M(cyl(0.008, 0.008, 1.0, 6), std("#14100c"), lx, WALL_H - 0.5, lz, false));
      const shade = new THREE.Mesh(
        G("shade", () => new THREE.ConeGeometry(0.24, 0.22, 24, 1, true)),
        S("shadeMat", () => new THREE.MeshStandardMaterial({ color: "#f5b544", emissive: "#ffb347", emissiveIntensity: 1.2, side: THREE.DoubleSide, roughness: 0.5 })),
      );
      shade.position.set(lx, WALL_H - 1.05, lz);
      sg.add(shade);
      sg.add(M(sph(0.07), basic("#fff1c4"), lx, WALL_H - 1.12, lz, false));
      const glow = new THREE.Sprite(S("lampGlow", () => new THREE.SpriteMaterial({ map: glowTex(), color: "#ffb45a", blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.55 })));
      glow.scale.set(2.6, 2.6, 1);
      glow.position.set(lx, WALL_H - 1.15, lz);
      sg.add(glow);
      if (i % 2 === 0 || lamps < 6) {
        const pl = new THREE.PointLight("#ffb45a", 11, 9, 2);
        pl.position.set(lx, WALL_H - 1.2, lz + 0.2);
        sg.add(pl);
      }
    }
    // warm light from the LED strips
    for (const [px, pz] of [[-W / 4, -D / 2 + 0.7], [W / 4, -D / 2 + 0.7]]) {
      const pl = new THREE.PointLight("#ff9a3c", 7, 10, 2);
      pl.position.set(px, WALL_H - 0.4, pz);
      sg.add(pl);
    }
    for (const sgn of [-1, 1]) {
      const pl = new THREE.PointLight("#ff9a3c", 6, 10, 2);
      pl.position.set(sgn * (W / 2 - 0.6), 2.6, D * 0.15);
      sg.add(pl);
    }

    // counter with pastry display, coffee machine and POS (left wall)
    const cl = Math.min(3.6, D - 2.2);
    const cz = -D / 2 + 0.9 + cl / 2;
    const cx = -W / 2 + 0.75;
    sg.add(M(box(1.2, 1.0, cl, 0.05), std("#3a2415", { roughness: 0.6 }), cx, 0.5, cz));
    sg.add(M(box(1.38, 0.07, cl + 0.18, 0.03), std("#8a5a33", { roughness: 0.4 }), cx, 1.03, cz));
    sg.add(M(box(0.9, 0.62, cl - 1.3, 0.03), std("#cfe9ff", { transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.1 }), cx + 0.08, 1.38, cz + 0.55, false));
    for (let i = 0; i < 8; i++) {
      const c = pick(["#d9923b", "#f4b7c8", "#8a4b2a", "#f7d88a"], i);
      const sw = new THREE.Mesh(sph(0.1), std(c, { roughness: 0.5 }));
      sw.scale.set(1.1, 0.55, 1.1);
      sw.position.set(cx + 0.08 + (i % 2 ? 0.2 : -0.12), 1.2 + (i % 4 > 1 ? 0.28 : 0), cz + 0.05 + ((i % 4) * (cl - 1.5)) / 4 + (i > 3 ? 0.2 : 0));
      sw.castShadow = true;
      sg.add(sw);
    }
    // coffee machine + cups at the far end, POS screen at the near end
    sg.add(M(box(0.5, 0.55, 0.5, 0.05), std("#2b2f36", { metalness: 0.6, roughness: 0.35 }), cx + 0.1, 1.34, cz - cl / 2 + 0.45));
    sg.add(M(box(0.52, 0.06, 0.52, 0.02), std("#c9ced6", { metalness: 0.8, roughness: 0.25 }), cx + 0.1, 1.64, cz - cl / 2 + 0.45));
    for (let i = 0; i < 3; i++) sg.add(M(cyl(0.05, 0.04, 0.09, 12), std("#f1e6d2"), cx - 0.25, 1.12, cz - cl / 2 + 0.3 + i * 0.16));
    sg.add(M(box(0.34, 0.3, 0.42, 0.03), std("#15151a"), cx + 0.1, 1.2, cz + cl / 2 - 0.15));
    sg.add(M(box(0.04, 0.2, 0.32, 0.01), basic("#38bdf8"), cx - 0.1, 1.2, cz + cl / 2 - 0.15, false));

    // big potted plants (cream pots) along the walls and at the front corners, small lime plants in the aisles
    const cream = { pot: "#e9dfcb" };
    addPlant(sg, W / 2 - 0.6, 0, -D / 2 + 0.7, 1.25, cream);
    L.rowZ.forEach((z, r) => {
      addPlant(sg, W / 2 - 0.6, 0, z + 0.2, 1.1, cream);
      if (r >= 1) addPlant(sg, -W / 2 + L.LR - 0.5, 0, z, 1.1, cream);
    });
    addPlant(sg, W / 2 - 0.7, 0, D / 2 - 0.7, 1.55, cream);
    addPlant(sg, -W / 2 + 1.0, 0, D / 2 - 0.8, 1.4, cream);
    L.rowZ.forEach((z, r) => {
      for (let j = 0; j < L.cols - 1; j++) {
        if (r * L.cols + j + 1 < L.n) addAislePlants(sg, L.colB[j], z);
      }
    });

    // soft light + sun
    sg.add(new THREE.HemisphereLight("#ffd9a0", "#5a3216", 1.1));
    const sun = new THREE.DirectionalLight("#ffd6a0", 1.45);
    sun.position.set(W * 0.25, 9, D * 0.4);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -W / 2 - 1;
    sun.shadow.camera.right = W / 2 + 1;
    sun.shadow.camera.top = D / 2 + 3;
    sun.shadow.camera.bottom = -D / 2 - 3;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 30;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    sg.add(sun);
    sg.add(sun.target);

    scene.add(sg);
    staticGroup = sg;
    room = L;
  }

  /* ---------- tables (rebuilt when a table changes state) ---------- */
  let tablesGroup = null;
  let hits = [];
  let tableInfo = new Map(); // id -> { group, sel }
  const ringMats = [];

  // level: "full" | "soft" | "dim"
  const ringMat = (color, level) =>
    S(`ring:${color}:${level}`, () => {
      const base = level === "dim" ? 0.25 : level === "soft" ? 0.5 : 1;
      const m = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: base });
      m.userData.base = base;
      ringMats.push(m);
      return m;
    });
  const haloMat = (color, dim) =>
    S(`halo:${color}:${dim}`, () => new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: dim ? 0.05 : 0.27, blending: THREE.AdditiveBlending, depthWrite: false }));
  const glowMat = (color, level) =>
    S(`glowfloor:${color}:${level}`, () => new THREE.MeshBasicMaterial({ map: glowTex(), color, toneMapped: false, transparent: true, opacity: level === "dim" ? 0.15 : level === "soft" ? 0.28 : 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));

  const ringGeo = (a, b, p, tube) =>
    G(`ring:${a.toFixed(2)}:${b.toFixed(2)}:${p}:${tube}`, () => {
      const pts = [];
      const N = 72;
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2;
        const c = Math.cos(t);
        const s = Math.sin(t);
        const sg = (v) => (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), 2 / p);
        pts.push(new THREE.Vector3(a * sg(c), 0.03, b * sg(s)));
      }
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 160, tube, 8, true);
    });

  function personMeshes(seat, key) {
    const g = new THREE.Group();
    const shirt = pick(SHIRTS, key);
    const skin = pick(SKINS, key * 3 + 1);
    const hair = pick(HAIRS, key * 5 + 2);
    const pants = "#2a3140";
    g.add(M(cap(0.14, 0.3), std(shirt, { roughness: 0.8 }), 0, 0.84, -0.03));
    g.add(M(sph(0.11), std(skin, { roughness: 0.7 }), 0, 1.2, 0.0));
    const cp = new THREE.Mesh(G("hair", () => new THREE.SphereGeometry(0.118, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.58)), std(hair, { roughness: 0.9 }));
    cp.position.set(0, 1.205, -0.012);
    cp.castShadow = true;
    g.add(cp);
    g.add(M(sph(0.012, 6, 6), basic("#1b1b1f"), -0.04, 1.21, 0.1, false));
    g.add(M(sph(0.012, 6, 6), basic("#1b1b1f"), 0.04, 1.21, 0.1, false));
    for (const sx of [-1, 1]) {
      const th = M(cap(0.075, 0.28), std(pants, { roughness: 0.8 }), sx * 0.085, 0.52, 0.2);
      th.rotation.x = Math.PI / 2;
      g.add(th);
      g.add(M(cap(0.065, 0.3), std(pants, { roughness: 0.8 }), sx * 0.085, 0.26, 0.36));
      const arm = M(cap(0.045, 0.24), std(shirt, { roughness: 0.8 }), sx * 0.2, 0.84, 0.15);
      arm.rotation.x = 1.9;
      g.add(arm);
      g.add(M(sph(0.045, 8, 8), std(skin), sx * 0.2, 0.76, 0.34));
    }
    g.rotation.y = Math.atan2(-seat.ox, -seat.oz);
    g.position.set(seat.x, seat.sofa ? -0.04 : 0.0, seat.z);
    return g;
  }

  // round "tub" chair: cushion + curved back, in the reference colours (tan / olive)
  function chairMesh(seat, color) {
    const g = new THREE.Group();
    const mat = std(color, { roughness: 0.65 });
    const metal = std("#15151a", { metalness: 0.6, roughness: 0.4 });
    g.add(M(cyl(0.23, 0.2, 0.1, 24), mat, 0, 0.44, 0));
    g.add(M(cyl(0.035, 0.045, 0.38, 10), metal, 0, 0.2, 0));
    g.add(M(cyl(0.16, 0.16, 0.03, 18), metal, 0, 0.015, 0));
    const bk = new THREE.Mesh(G("chairBack", () => new THREE.CylinderGeometry(0.255, 0.245, 0.4, 24, 1, true, Math.PI - 0.95, 1.9)), std(color, { roughness: 0.65, side: THREE.DoubleSide }));
    bk.position.set(0, 0.72, 0);
    bk.castShadow = true;
    g.add(bk);
    g.rotation.y = Math.atan2(-seat.ox, -seat.oz);
    g.position.set(seat.x, 0, seat.z);
    return g;
  }

  // green sofa along the back of a "sofa" table, with two cream cushions
  function sofaMesh(d) {
    const g = new THREE.Group();
    const mat = std(SOFA_GREEN, { roughness: 0.8 });
    const w = d.sw;
    g.add(M(box(w, 0.4, 0.8, 0.08), mat, 0, 0.2, -0.65));
    g.add(M(box(w, 0.62, 0.2, 0.08), mat, 0, 0.62, -1.0));
    for (const sx of [-1, 1]) g.add(M(box(0.18, 0.55, 0.85, 0.07), mat, sx * (w / 2 - 0.09), 0.38, -0.62));
    for (const sx of [-1, 1]) {
      const pil = M(box(0.42, 0.34, 0.12, 0.05), std("#f1dcc0", { roughness: 0.9 }), sx * w * 0.27, 0.74, -0.84);
      pil.rotation.x = -0.15;
      g.add(pil);
    }
    return g;
  }

  function buildTable(it, p) {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    const n = Math.max(1, Math.min(Number(it.capacity) || 4, 10));
    const shape = it.shape || "round";
    const d = p.d;
    const cz = d.tz || 0;
    const lk = look(it.phase);
    const level = it.dim ? "dim" : lk.soft ? "soft" : "full";
    const seed = Number(it.id) || 1;
    const food = it.phase === "served" || it.phase === "bill";
    const guests = Math.max(0, Math.min(Number(it.guests) || 0, n));
    const marble = S("m:marble", () => new THREE.MeshStandardMaterial({ map: marbleTex(), roughness: 0.55, metalness: 0.05 }));
    const dark = std("#0c0c10", { roughness: 0.4, metalness: 0.3 });
    const gold = std("#d9a93f", { roughness: 0.3, metalness: 0.85 });
    const legMat = std("#15151a", { metalness: 0.7, roughness: 0.35 });

    // table
    if (d.kind === "round") {
      g.add(M(G(`ttop:${d.R}`, () => new THREE.CylinderGeometry(d.R, d.R, 0.06, 48)), [dark, marble, dark], 0, 0.73, 0));
      g.add(M(G(`trim:${d.R}`, () => new THREE.TorusGeometry(d.R, 0.017, 8, 64)), gold, 0, 0.76, 0));
      g.children[g.children.length - 1].rotation.x = Math.PI / 2;
      g.add(M(cyl(0.06, 0.07, 0.7, 16), legMat, 0, 0.36, 0));
      g.add(M(cyl(d.R * 0.42, d.R * 0.46, 0.04, 32), dark, 0, 0.02, 0));
    } else {
      g.add(M(box(d.hx * 2 + 0.04, 0.045, d.hz * 2 + 0.04, 0.015), gold, 0, 0.715, cz));
      g.add(M(G(`btop:${d.hx}:${d.hz}`, () => new RoundedBoxGeometry(d.hx * 2, 0.06, d.hz * 2, 2, 0.02)), [dark, dark, marble, dark, dark, dark], 0, 0.745, cz));
      for (const sx of [-1, 1]) g.add(M(cyl(0.035, 0.04, 0.7, 10), legMat, sx * (d.hx - 0.15), 0.35, cz));
    }
    if (d.kind === "sofa") g.add(sofaMesh(d));

    // chairs, guests, things on the table
    const seats = seatsOf(d, shape, n);
    const seated = spread(seats.length, guests);
    const seatedSet = new Set(seated);
    const chairColor = shape === "square" || shape === "sofa" ? OLIVE : TAN;
    seats.forEach((s, i) => {
      if (!s.sofa) g.add(chairMesh(s, chairColor));
      if (seatedSet.has(i)) g.add(personMeshes(s, seed * 7 + i * 3));
    });
    seated.forEach((si, k) => {
      const s = seats[si];
      const dist = 0.34 + s.ext * 0.45;
      const ix = s.x - s.ox * dist;
      const iz = s.z - s.oz * dist;
      if (food) {
        g.add(M(cyl(0.12, 0.1, 0.018, 24), std("#f8f8f5", { roughness: 0.3 }), ix, 0.775, iz));
        for (let f = 0; f < 3; f++) {
          const fm = M(sph(0.032, 8, 6), std(pick(FOODS, seed + k + si + f), { roughness: 0.6 }), ix + (f - 1) * 0.045, 0.8, iz + (f === 1 ? 0.03 : -0.015), false);
          fm.scale.y = 0.8;
          g.add(fm);
        }
      } else {
        const ph = M(box(0.07, 0.012, 0.145, 0.006), std("#15151a", { roughness: 0.3 }), ix, 0.778, iz);
        ph.rotation.y = Math.atan2(-s.ox, -s.oz) + (((seed + k) % 5) - 2) * 0.08;
        g.add(ph);
        const sc = new THREE.Mesh(G("screen", () => new THREE.PlaneGeometry(0.06, 0.128)), basic(pick(SCREENS, seed + k)));
        sc.rotation.x = -Math.PI / 2;
        sc.position.set(0, 0.0072, 0);
        ph.add(sc);
      }
    });
    // centre piece: yellow flowers on every table (like the reference), receipt for a pending bill, broom badge when cleaning
    g.add(M(cyl(0.022, 0.03, 0.12, 10), std("#c8e6f5", { transparent: true, opacity: 0.8, roughness: 0.1 }), it.phase === "bill" ? 0.1 : 0, 0.82, cz, false));
    for (let f = 0; f < 3; f++) g.add(M(sph(0.034, 8, 8), std(pick(["#fbbf24", "#fde047", "#fb923c"], f), { roughness: 0.6 }), (it.phase === "bill" ? 0.1 : 0) + (f - 1) * 0.032, 0.9 + (f === 1 ? 0.03 : 0), cz, false));
    if (it.phase === "bill") {
      const rc = new THREE.Mesh(G("receipt", () => new THREE.PlaneGeometry(0.16, 0.2)), S("receiptMat", () => new THREE.MeshBasicMaterial({ map: receiptTex(), side: THREE.DoubleSide, toneMapped: false })));
      rc.position.set(-0.08, 0.9, cz);
      rc.rotation.x = -0.25;
      g.add(rc);
    } else if (it.phase === "cleaning") {
      const bs = new THREE.Sprite(S("broomMat", () => new THREE.SpriteMaterial({ map: broomTex(), transparent: true, depthWrite: false })));
      bs.scale.set(0.75, 0.75, 1);
      bs.position.set(0, 1.35, cz);
      g.add(bs);
    } else if (it.phase === "reserved") {
      const card = M(box(0.16, 0.1, 0.01, 0.004), std("#ffffff"), 0.12, 0.82, cz, false);
      card.rotation.x = -0.3;
      g.add(card);
    }

    // glowing ring on the floor
    const soft = !!lk.soft;
    g.add(new THREE.Mesh(ringGeo(d.a, d.b, d.p, soft ? 0.022 : 0.05), ringMat(lk.ring, level)));
    if (!soft) g.add(new THREE.Mesh(ringGeo(d.a, d.b, d.p, 0.17), haloMat(lk.ring, !!it.dim)));
    const gl = new THREE.Mesh(G(`gl:${d.a}:${d.b}`, () => new THREE.PlaneGeometry(d.a * 2.5, d.b * 2.5)), glowMat(lk.ring, level));
    gl.rotation.x = -Math.PI / 2;
    gl.position.y = 0.012;
    g.add(gl);
    const selRing = new THREE.Mesh(ringGeo(d.a + 0.08, d.b + 0.08, d.p, 0.018), basic("#ffffff"));
    selRing.visible = false;
    g.add(selRing);

    // invisible click target
    const hit = new THREE.Mesh(G(`hit:${d.a}:${d.b}`, () => new THREE.CircleGeometry(Math.max(d.a, d.b), 24)), S("hitMat", () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })));
    hit.rotation.x = -Math.PI / 2;
    hit.position.y = 0.5;
    hit.userData.tid = it.id;
    g.add(hit);
    hits.push(hit);
    g.userData.tid = it.id;
    tableInfo.set(it.id, { group: g, sel: selRing });
    return g;
  }

  /* ---------- html labels: name box, seats, status pill, caption ---------- */
  let labels = [];
  function buildLabels(items) {
    labels.forEach((l) => l.el.remove());
    labels = [];
    items.forEach((it, i) => {
      const p = room.pos[i];
      const lk = look(it.phase);
      const el = document.createElement("div");
      el.className = "r3-lab";
      el.style.opacity = it.dim ? "0.3" : "1";
      el.innerHTML = `<div class="r3-nm"></div><div class="r3-seats"></div><div class="r3-pill" style="background:${lk.pill};--c:${lk.ring || lk.pill}"><i></i><span></span></div><div class="r3-sub"></div>`;
      el.querySelector(".r3-nm").textContent = it.name;
      el.querySelector(".r3-seats").textContent = `👥 ${it.capacity} Seats`;
      el.querySelector(".r3-pill span").textContent = `${it.label}${it.guests > 0 ? ` (${it.guests})` : ""}`;
      el.querySelector(".r3-sub").textContent = it.sub || "";
      el.addEventListener("click", () => onPick(it.id));
      labelLayer.appendChild(el);
      labels.push({ el, id: it.id, x: p.x, z: p.z + p.d.b - 0.35, a: p.d.a });
    });
  }

  /* ---------- update (called whenever tables / selection change) ---------- */
  let layoutKey = "";
  let tableKey = "";
  let selected = null;
  let currentItems = [];
  function update({ items, selected: sel, cafeName }) {
    currentItems = items || [];
    selected = sel == null ? null : sel;
    const L = computeLayout(currentItems, cafeName);
    const lk = `${L.n}|${cafeName}|${currentItems.map((i) => `${i.capacity}${i.shape}`).join(",")}`;
    if (lk !== layoutKey) {
      layoutKey = lk;
      buildStatic(L);
      tableKey = "";
      resize();
    }
    const tk = currentItems.map((i) => [i.id, i.capacity, i.shape, i.phase, i.guests, i.dim ? 1 : 0].join(":")).join("|");
    if (tk !== tableKey) {
      tableKey = tk;
      if (tablesGroup) scene.remove(tablesGroup);
      tablesGroup = new THREE.Group();
      hits = [];
      tableInfo = new Map();
      currentItems.forEach((it, i) => tablesGroup.add(buildTable(it, room.pos[i])));
      scene.add(tablesGroup);
    }
    buildLabels(currentItems);
    tableInfo.forEach((v, id) => {
      v.sel.visible = id === selected;
    });
    labels.forEach((l) => l.el.classList.toggle("on", l.id === selected));
  }

  /* ---------- camera: fit the room, orbit / zoom, zoom to the selected table ---------- */
  const v3 = new THREE.Vector3();
  const v3b = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const by = new THREE.Vector3();
  const bz = new THREE.Vector3();
  const fitT = new THREE.Vector3(0, 0.9, 0.2); // where the camera looks when nothing is selected
  const cur = new THREE.Vector3(0, 0.9, 0.2); // where it looks right now (eases towards the goal)
  let fitDist = 20;
  let curDist = 20;
  let az = 0; // turn left / right (drag)
  let el = PITCH; // tilt (drag)
  let zoom = 1; // + / - buttons, Ctrl + wheel
  let viewW = 800;
  let viewH = 500;
  function resize() {
    if (!room) return;
    viewW = Math.max(320, host.clientWidth || 800);
    const asp = (room.W + 0.8) / (room.D * Math.sin(PITCH) + WALL_H * Math.cos(PITCH) + 1.4);
    viewH = Math.round(Math.min(900, Math.max(380, viewW / asp)));
    host.style.height = viewH + "px";
    renderer.setSize(viewW, viewH, false);
    camera.aspect = viewW / viewH;
    camera.updateProjectionMatrix();
    const ext = fitCamera();
    // the room is wider than tall on screen: shrink the box so there is no empty dark band above/below
    if (ext.h > 0.2 && ext.h < 1.75) {
      viewH = Math.round(Math.max(340, viewH * Math.max(0.7, ext.h / 1.9)));
      host.style.height = viewH + "px";
      renderer.setSize(viewW, viewH, false);
      camera.aspect = viewW / viewH;
      camera.updateProjectionMatrix();
      fitCamera();
    }
  }
  // move/zoom the camera until the 8 corners of the room fill the screen (small margin), centred
  function fitCamera() {
    let ew = 2;
    let eh = 2;
    const tanV = Math.tan((FOV * Math.PI) / 360);
    const tanH = tanV * camera.aspect;
    target.set(0, 0.9, 0.2);
    let dist = Math.max((room.W * 0.55) / tanH, (room.D * 0.7) / tanV);
    for (let it = 0; it < 4; it++) {
      camera.position.set(target.x, target.y + Math.sin(PITCH) * dist, target.z + Math.cos(PITCH) * dist);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      let mnx = 1e9;
      let mxx = -1e9;
      let mny = 1e9;
      let mxy = -1e9;
      for (const x of [-room.W / 2, room.W / 2])
        for (const y of [0, WALL_H])
          for (const z of [-room.D / 2, room.D / 2]) {
            v3.set(x, y, z).project(camera);
            mnx = Math.min(mnx, v3.x);
            mxx = Math.max(mxx, v3.x);
            mny = Math.min(mny, v3.y);
            mxy = Math.max(mxy, v3.y);
          }
      ew = mxx - mnx;
      eh = mxy - mny;
      const f = Math.max((mxx - mnx) / 1.92, (mxy - mny) / 1.92);
      if (isFinite(f) && f > 0.05) dist *= f;
      const cxn = (mxx + mnx) / 2;
      const cyn = (mxy + mny) / 2;
      if (isFinite(cxn) && isFinite(cyn)) {
        camera.matrixWorld.extractBasis(bx, by, bz);
        target.addScaledVector(bx, cxn * dist * tanH).addScaledVector(by, cyn * dist * tanV);
      }
    }
    fitT.copy(target);
    fitDist = dist;
    return { w: ew, h: eh };
  }
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(host);

  /* ---------- mouse / touch ---------- */
  const ray = new THREE.Raycaster();
  const v2 = new THREE.Vector2();
  function rayHit(e) {
    const r = host.getBoundingClientRect();
    v2.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    ray.setFromCamera(v2, camera);
    const h = ray.intersectObjects(hits, false);
    return h.length ? h[0].object.userData.tid : null;
  }
  let drag = null;
  let moved = 0;
  const onDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest(".r3-lab,.r3-ctrl")) return;
    drag = { x: e.clientX, y: e.clientY };
    moved = 0;
  };
  const onMove = (e) => {
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX;
      drag.y = e.clientY;
      az = Math.max(-1.0, Math.min(1.0, az - dx * 0.005));
      el = Math.max(PITCH - 0.3, Math.min(PITCH + 0.4, el + dy * 0.004));
      host.style.cursor = "grabbing";
      return;
    }
    host.style.cursor = rayHit(e) != null ? "pointer" : "grab";
  };
  const onUp = () => {
    drag = null;
  };
  const onClick = (e) => {
    if (moved > 5) return; // it was a drag, not a click
    if (e.target && e.target.closest && e.target.closest(".r3-lab,.r3-ctrl")) return;
    const id = rayHit(e);
    if (id != null) onPick(id);
  };
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // plain wheel keeps scrolling the page
    e.preventDefault();
    zoom = Math.max(0.35, Math.min(1.3, zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
  };
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  host.addEventListener("click", onClick);
  host.addEventListener("wheel", onWheel, { passive: false });

  // + / - / reset buttons
  const ctrl = document.createElement("div");
  ctrl.className = "r3-ctrl";
  const mkBtn = (txt, title, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "r3-btn";
    b.textContent = txt;
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    ctrl.appendChild(b);
  };
  mkBtn("+", "Zoom in", () => (zoom = Math.max(0.35, zoom * 0.8)));
  mkBtn("−", "Zoom out", () => (zoom = Math.min(1.3, zoom * 1.25)));
  mkBtn("⟲", "Reset camera", () => {
    az = 0;
    el = PITCH;
    zoom = 1;
    onPick(null);
  });
  host.appendChild(ctrl);

  /* ---------- render loop ---------- */
  let raf = 0;
  let running = true;
  const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((es) => (running = es[0].isIntersecting && !document.hidden)) : null;
  if (io) io.observe(host);
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (!running || !room) return;
    const t = ts / 1000;
    // where the camera wants to look: the selected table (zoomed in) or the whole room
    const sel = selected != null ? tableInfo.get(selected) : null;
    const gx = sel ? sel.group.position.x : fitT.x;
    const gy = sel ? 0.6 : fitT.y;
    const gz = sel ? sel.group.position.z + 0.25 : fitT.z;
    const gd = fitDist * zoom * (sel ? 0.5 : 1);
    cur.x += (gx - cur.x) * 0.08;
    cur.y += (gy - cur.y) * 0.08;
    cur.z += (gz - cur.z) * 0.08;
    curDist += (gd - curDist) * 0.08;
    const cd = Math.cos(el);
    camera.position.set(cur.x + Math.sin(az) * cd * curDist, cur.y + Math.sin(el) * curDist, cur.z + Math.cos(az) * cd * curDist);
    camera.lookAt(cur);
    const k = 0.78 + 0.22 * Math.sin(t * 2.2);
    ringMats.forEach((m) => (m.opacity = (m.userData.base || 1) * k));
    tableInfo.forEach((v, id) => {
      const s = id === selected ? 1.03 : 1;
      v.group.scale.x += (s - v.group.scale.x) * 0.2;
      v.group.scale.y = v.group.scale.z = v.group.scale.x;
    });
    renderer.render(scene, camera);
    labels.forEach((l) => {
      v3.set(l.x, 0.05, l.z).project(camera);
      v3b.set(l.x + l.a, 0.05, l.z).project(camera);
      const vis = v3.z < 1 && Math.abs(v3.x) < 1.15 && Math.abs(v3.y) < 1.15;
      l.el.style.display = vis ? "" : "none";
      if (vis) {
        // label size follows how big the table looks on screen (far tables = smaller label)
        const dia = Math.abs(v3b.x - v3.x) * viewW;
        const sc = Math.max(0.6, Math.min(1.15, dia / 195));
        l.el.style.transform = `translate(${((v3.x * 0.5 + 0.5) * viewW).toFixed(1)}px,${((-v3.y * 0.5 + 0.5) * viewH).toFixed(1)}px) translateX(-50%) scale(${sc.toFixed(3)})`;
      }
    });
  }
  raf = requestAnimationFrame(loop);

  function dispose() {
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    if (io) io.disconnect();
    host.removeEventListener("pointerdown", onDown);
    host.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    host.removeEventListener("click", onClick);
    host.removeEventListener("wheel", onWheel);
    shared.forEach((v) => {
      if (v && v.dispose) v.dispose();
    });
    shared.clear();
    renderer.dispose();
    if (renderer.forceContextLoss) renderer.forceContextLoss();
    cvHost.remove();
    labelLayer.remove();
    ctrl.remove();
  }

  return { update, dispose };
}

const ROOM3D_CSS = `
.r3-wrap{position:relative;width:100%;min-height:340px;border-radius:18px !important;overflow:hidden;background:#0b1510;border:1px solid rgba(255,255,255,.08);box-shadow:0 14px 40px rgba(0,0,0,.35);--fs:15px;cursor:grab;touch-action:pan-y;user-select:none}
.r3-cv{position:absolute;inset:0}
.r3-labels{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.r3-lab{position:absolute;left:0;top:0;transform-origin:50% 0;text-align:center;pointer-events:auto;cursor:pointer;user-select:none;will-change:transform;transition:opacity .2s}
.r3-nm{display:inline-block;font-weight:800;color:#fff;font-size:calc(var(--fs)*1.25);line-height:1.15;padding:.08em .7em;background:rgba(8,16,11,.86);border:1px solid rgba(255,255,255,.2);border-radius:8px !important;text-shadow:0 1px 3px #000}
.r3-seats{font-weight:600;color:#fff;font-size:calc(var(--fs)*.78);margin:.12em 0 .18em;white-space:nowrap;text-shadow:0 1px 4px #000,0 0 2px #000}
.r3-pill{display:inline-flex;align-items:center;gap:.45em;padding:.2em .8em .22em .6em;border-radius:999px !important;color:#fff;font-weight:700;font-size:var(--fs);white-space:nowrap;border:1px solid rgba(255,255,255,.4);box-shadow:0 0 14px var(--c),0 2px 6px rgba(0,0,0,.5)}
.r3-pill i{width:.55em;height:.55em;border-radius:50% !important;background:#fff;display:inline-block}
.r3-sub{font-weight:600;color:#fff;font-size:calc(var(--fs)*.82);margin-top:.2em;white-space:nowrap;text-shadow:0 1px 4px #000,0 0 2px #000}
.r3-lab.on .r3-nm{outline:2px solid #fff;outline-offset:1px}
.r3-lab.on .r3-pill{outline:2px solid #fff;outline-offset:2px}
.r3-ctrl{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:5}
.r3-btn{width:34px;height:34px;padding:0;border:1px solid rgba(255,255,255,.28);background:rgba(8,16,11,.82);color:#fff;font-size:18px;font-weight:700;line-height:1;cursor:pointer;border-radius:10px !important}
.r3-btn:hover{background:rgba(34,197,94,.9)}
`;

// ============================ 3D ROOM COMPONENT ============================
// Real 3D café room. three.js is loaded only when this component is shown.
// If 3D cannot start (old browser, WebGL switched off), `fallback` (the tile Floor View) is shown instead.
function Room3D({ items, selected, cafeName, onPick, fallback }) {
  const host = useRef(null);
  const api = useRef(null);
  const latest = useRef({ items, selected, cafeName, onPick });
  latest.current = { items, selected, cafeName, onPick };
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    let ctl = null;
    (async () => {
      try {
        const THREE = await import("three");
        const { RoundedBoxGeometry } = await import("three/examples/jsm/geometries/RoundedBoxGeometry.js");
        if (dead || !host.current) return;
        ctl = createRoom(THREE, RoundedBoxGeometry, host.current, (id) => latest.current.onPick(id));
        api.current = ctl;
        ctl.update(latest.current);
      } catch (e) {
        console.error("3D room could not start, showing the flat room instead:", e);
        if (!dead) setFailed(true);
      }
    })();
    return () => {
      dead = true;
      api.current = null;
      if (ctl) ctl.dispose();
    };
  }, []);

  useEffect(() => {
    if (api.current) api.current.update({ items, selected, cafeName });
  }, [items, selected, cafeName]);

  if (failed) return fallback;
  return (
    <>
      <style>{ROOM3D_CSS}</style>
      <div ref={host} className="r3-wrap" />
    </>
  );
}

// round / square / long come from tableScene; some 4-6 seat tables become green-sofa booths (like the reference)
function roomShape(t) {
  if (["round", "square", "long", "sofa"].includes(t.shape)) return t.shape;
  const n = Number(t.capacity) || 4;
  if (n >= 4 && n <= 6 && Number(t.id) % 7 === 4) return "sofa";
  return tableShape(t.capacity, t.id);
}

// Turns the live tables into what the room needs (name, status, guests, small caption)
function roomItems(tables, shownKey) {
  const shownIds = new Set(shownKey ? shownKey.split(",").map(Number) : []);
  return tables.map((t) => {
    const phase = phaseOf(t);
    const live = ["occupied", "served", "bill"].includes(phase);
    const guests = live ? t.seated || t.order?.guests || 0 : 0;
    let sub = "";
    if (live && t.order) sub = `⏱ ${elapsed(t.status_since)} | ${money(t.order.total)}`;
    else if (phase === "occupied") sub = "QR Scanned – Ordering";
    else if (phase === "reserved") sub = `${t.reserved_for || "Reserved"}${t.reserved_at ? ` · ${fmtTime(t.reserved_at)}` : ""}`;
    else if (phase === "cleaning") sub = "Est. 15 min";
    return {
      id: t.id,
      name: /^\d+$/.test(String(t.name)) ? `Table ${t.name}` : t.name,
      capacity: t.capacity,
      shape: roomShape(t),
      phase,
      label: labelOf(phase),
      guests,
      sub,
      dim: !shownIds.has(t.id),
    };
  });
}

function RoomView({ tables, shownKey, sel, onPick, cafeName, fallback }) {
  const items = useMemo(() => roomItems(tables, shownKey), [tables, shownKey]);
  return (
    <Room3D
      items={items}
      selected={sel}
      cafeName={cafeName}
      onPick={onPick}
      fallback={fallback}
    />
  );
}

function Detail({ id, onClose, refresh, admin }) {
  const { can, settings } = useAuth();
  const { toast, ask } = useUI();
  const d = useFetch(`/tables/${id}`, null, [id]);
  const [rec, setRec] = useState(false);
  const [move, setMove] = useState(false);
  const [qrData, setQrData] = useState("");
  const [qrLink, setQrLink] = useState("");

  const all = useFetch("/tables");
  const t = d.data?.table;
  if (!t)
    return (
      <div className="side-panel">
        {d.error ? <ErrorBox msg={d.error} /> : <Loading />}
      </div>
    );
  const go = (path, state) => navigate(admin ? "/admin" + path : path, state);
  const posPath = admin ? "/admin/pos" : "/";

const makeQr = () => {
  const env = process.env.REACT_APP_PUBLIC_URL;
  const isLocal = (u) =>
    /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u || "");
  const baseUrl = (env && !isLocal(env) ? env : window.location.origin).replace(/\/$/, "");

  const url = `${baseUrl}/customer-order/${t.qr_token}`;
  setQrLink(url);
  setQrData(
    `https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=12&data=${encodeURIComponent(url)}`,
  );
};






  const printQr = () => {
    document.body.classList.add("print-qr");
    const done = () => {
      document.body.classList.remove("print-qr");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  };



  const cancel = async () => {
    const reason = await ask(
      `Cancel the active order on ${t.name}? Enter a reason:`,
      {
        input: true,
        danger: true,
        okText: "Cancel order",
        title: "Cancel order",
      },
    );
    if (reason)
      try {
        await api(`/orders/${t.order.id}/cancel`, {
          method: "POST",
          body: { reason },
        });
        toast("Order cancelled.");
        d.reload();
        refresh();
      } catch (e) {
        toast(e.message, "err");
      }
  };
  return (
    <div className="side-panel">
      <div className="sp-h">
        <h3>Table {t.name}</h3>
        <button className="btn sm dng" onClick={onClose}>
          <Icon n="x" /> Close
        </button>
      </div>
      {admin && can("tables.manage") && (
        <button
          className="btn pri block"
          onClick={makeQr}
          disabled={!t.qr_token}
        >
          <Icon n="qr" /> {"Generate / Download Table QR"}
        </button>
      )}
      <div className="chips2">
        <Badge v={t.status} />
        <span className="chip2">
          <Icon n="clock" /> {fmtTime(t.status_since)} (
          {elapsed(t.status_since)})
        </span>
        <span className="chip2">
          <Icon n="users" /> {t.capacity} seats
        </span>
      </div>
      {t.party && !t.order && (
        <div className="kv">
          <span>
            <Icon n="users" /> Guests seated
          </span>
          <b>{t.party} (scanned QR, no order yet)</b>
        </div>
      )}
      {t.status === "reserved" && (
        <div className="kv">
          <span>Reserved for</span>
          <b>
            {t.reserved_for}
            {t.reserved_phone ? ` · ${t.reserved_phone}` : ""}
            {t.reserved_at ? ` · ${fmtDT(t.reserved_at)}` : ""}
          </b>
        </div>
      )}
      {t.order ? (
        <>
          <h4 className="sp-t">Current Order</h4>
          <div className="hl">
            <b>Order {t.order.bill_no}</b>
            <button
              className="lnk"
              onClick={() => go("/orders", { openId: t.order.id })}
            >
              View in Orders
            </button>
          </div>
          <div className="kv">
            <span>
              <Icon n="user" /> Customer
            </span>
            <b>{t.order.customer_name}</b>
          </div>
          <div className="kv">
            <span>
              <Icon n="users" /> Guests
            </span>
            <b>{t.order.guests}</b>
          </div>
          <div className="kv">
            <span>Order Type</span>
            <b>Dine In</b>
          </div>
          <div className="kv">
            <span>Total</span>
            <b>
              {money(t.order.total)} ({t.items.length} items)
            </b>
          </div>
          {can("pos") && (
            <button
              className="btn pri block"
              onClick={() => navigate(posPath, { orderId: t.order.id })}
            >
              <Icon n="plus" /> Add Items to Order
            </button>
          )}
          <h4 className="sp-t">Order Items ({t.items.length})</h4>
          <div className="oitems">
            {t.items.map((i, k) => (
              <div key={k} className="oi">
                <div className="oi-n">
                  <b>{i.product_name}</b>
                  <small>{money(i.unit_price)}</small>
                </div>
                <span>x {i.qty}</span>
                <b>{money(i.line_total)}</b>
              </div>
            ))}
          </div>
          <div className="sums">
            <div>
              <span>Subtotal</span>
              <b>{money(t.order.subtotal)}</b>
            </div>
            {t.order.discount_amount > 0 && (
              <div>
                <span>Discount</span>
                <b>-{money(t.order.discount_amount)}</b>
              </div>
            )}
            <div>
              <span>GST</span>
              <b>{money(t.order.tax_amount)}</b>
            </div>
          </div>
          <div className="gtot">
            <span>Grand Total</span>
            <b>{money(t.order.total)}</b>
          </div>
          <div className="sp-actions">
            <button className="btn pri" onClick={() => setRec(true)}>
              <Icon n="print" /> Print Bill
            </button>
            {can("pos") && (
              <button className="btn" onClick={() => setMove(true)}>
                <Icon n="swap" /> Move Table
              </button>
            )}
            {can("orders.cancel") && (
              <button className="btn dng" onClick={cancel}>
                <Icon n="trash" /> Cancel Order
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="muted">No active order on this table.</p>
      )}

      
      {qrData &&
        createPortal(
          <Modal
            title={`Table ${t.name} · Customer QR`}
            onClose={() => setQrData("")}
            footer={
              <>
                <div className="qrm-actions">
                  <button className="btn" onClick={printQr}>
                    <Icon n="print" /> Print QR
                  </button>
                  <button
                    className="btn pri"
                    onClick={() =>
                      downloadQrCard(qrData, t.name, { name: settings.qr_brand_name || QR_BRAND.name, sub: settings.tagline || "" }).catch(() =>
                        toast("Could not create the image. Use Print QR instead.", "err"),
                      )
                    }
                  >
                    <Icon n="download" /> Download QR
                  </button>
                </div>
              </>
            }
          >
            {/localhost|127\.0\.0\.1/i.test(qrLink) && (
              <div className="qrm-warn">
                <b>This QR will not open on a customer’s phone.</b>
                <span>
                  It points to <code>{qrLink.replace(/\/customer-order\/.*/, "")}</code>, which is only your own
                  computer. Open this app using your PC’s network address (for example
                  http://192.168.x.x:3000), or set <code>REACT_APP_PUBLIC_URL</code> to your website
                  address, then generate the QR again.
                </span>
              </div>
            )}
            <div className="qrm-card">
              <div className="qrm-brand">
                <b>{settings.qr_brand_name || QR_BRAND.name}</b>
                {!!String(settings.tagline || "").trim() && <span>{settings.tagline.trim()}</span>}
              </div>
              <div className="qrm-table">TABLE {t.name}</div>
              <div className="qrm-img">
                <img src={qrData} alt={`QR Code ${t.name}`} />
              </div>
              <h4 className="qrm-title">SCAN &amp; ORDER</h4>
              <p className="qrm-sub">Order directly from your mobile — no waiting!</p>

              <section className="qrm-staff" aria-label="Call a staff member">
                <div className="qrm-staff-icon" aria-hidden="true">
                  <Icon n="bell" size={38} />
                </div>
                <div className="qrm-staff-copy">
                  <b>Scan to Call a Staff</b>
                  <span>Scan this QR to open the menu, then tap “Ring a Bell” to notify our staff.</span>
                </div>
              </section>

              <div className="qrm-help">Need help? Please ask our staff 🙂</div>
              <small className="qrm-powered">{QR_BRAND.powered}</small>
            </div>
          </Modal>,
          document.body,
        )}

      {rec && (
        <ReceiptModal orderId={t.order.id} onClose={() => setRec(false)} />
      )}
      {move && (
        <Modal title={`Move ${t.name} to…`} onClose={() => setMove(false)}>
          <div className="chips">
            {(all.data?.tables || [])
              .filter(
                (x) =>
                  x.id !== t.id && ["available", "cleaning"].includes(x.status),
              )
              .map((x) => (
                <button
                  key={x.id}
                  className="tchip"
                  onClick={async () => {
                    try {
                      await api(`/tables/${t.id}/move`, {
                        method: "POST",
                        body: { to_table_id: x.id },
                      });
                      toast("Order moved.");
                      setMove(false);
                      onClose();
                      refresh();
                    } catch (e) {
                      toast(e.message, "err");
                    }
                  }}
                >
                  {x.name}
                </button>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function Tables() {
  const { can, settings } = useAuth();
  const { toast, ask } = useUI();
  const { search, admin } = useShell();
  const list = useFetch("/tables", null, [], 4000);
  const [flt, setFlt] = useState("all");
  const [view, setView] = useState("room");
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState(null);
  const [res, setRes] = useState(null);
  const posPath = admin ? "/admin/pos" : "/";
  const all = list.data?.tables || [],
    counts = all.reduce((m, t) => {
      const k = phaseOf(t);
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {});
  const busy = (counts.occupied || 0) + (counts.served || 0) + (counts.bill || 0);
  const shown = all.filter(
    (t) =>
      (flt === "all" || phaseOf(t) === flt) &&
      t.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const cur = all.find((t) => t.id === sel);
  const quick = async (status, extra) => {
    try {
      const r = await api(`/tables/${sel}/status`, {
        method: "PATCH",
        body: { status, ...extra },
      });
      toast(r.message);
      list.reload();
    } catch (e) {
      toast(e.message, "err");
    }
  };
  const needSel = (fn) => () =>
    sel ? fn() : toast("Select a table first.", "err");
  const save = async () => {
    try {
      await api(form.id ? `/tables/${form.id}` : "/tables", {
        method: form.id ? "PUT" : "POST",
        body: { name: form.name, capacity: Number(form.capacity) || 4 },
      });
      toast("Table saved.");
      setForm(null);
      list.reload();
    } catch (e) {
      toast(e.message, "err");
    }
  };
  const del = async () => {
    if (
      await ask(`Delete table ${cur.name}?`, { danger: true, okText: "Delete" })
    )
      try {
        await api(`/tables/${cur.id}`, { method: "DELETE" });
        toast("Table deleted.");
        setSel(null);
        list.reload();
      } catch (e) {
        toast(e.message, "err");
      }
  };
  const legend = (
    <div className="t3d-legend">
      {[
        ["available", "#22c55e"],
        ["occupied", "#2563eb"],
        ["served", "#f59e0b"],
        ["bill", "#ef4444"],
      ].map(([k, c]) => (
        <span key={k} style={{ color: c }}>
          <i />
          <em style={{ fontStyle: "normal", color: "var(--tx2)" }}>{labelOf(k)}</em>
        </span>
      ))}
      <span style={{ color: "var(--tx2)", fontWeight: 500 }}>Number in brackets = guests seated</span>
    </div>
  );
  const floorGrid = (
    <div className="t3d-floor">
      {shown.map((t, i) => (
        <FloorTile key={t.id} i={i} t={t} on={sel === t.id} onClick={() => setSel(t.id)} />
      ))}
    </div>
  );
  return (
    <div className={`page split tables-page ${sel ? "has-panel" : ""}`}>
      <style>{T3D_CSS}</style>
      <div className="split-main">
        <div className="ph">
          <div>
            <h1>Tables</h1>
            <p className="muted">
              View table status, manage orders and handle customers
            </p>
          </div>
          <div className="row-end trow">
            <button
              className={`btn ${view === "room" ? "pri" : ""}`}
              onClick={() => setView("room")}
            >
              <Icon n="table" /> 3D Room
            </button>
            <button
              className={`btn ${view === "floor" ? "pri" : ""}`}
              onClick={() => setView("floor")}
            >
              <Icon n="grid" /> Floor View
            </button>
            <button
              className={`btn ${view === "list" ? "pri" : ""}`}
              onClick={() => setView("list")}
            >
              <Icon n="list" /> List View
            </button>
            {can("tables.manage") && (
              <button
                className="btn"
                onClick={() => setForm({ name: "", capacity: 4 })}
              >
                <Icon n="plus" /> New Table
              </button>
            )}
          </div>
        </div>
        <div className="tsum">
          {ST.map((k) => (
            <button
              key={k}
              className={`tsum-i ${k} ${flt === k ? "on" : ""}`}
              onClick={() => setFlt(flt === k ? "all" : k)}
            >
              <span>{labelOf(k)}</span>
              <b>{counts[k] || 0}</b>
            </button>
          ))}
          <div className="occ">
            <span>
              Occupancy{" "}
              <b>
                {all.length
                  ? Math.round((busy / all.length) * 100)
                  : 0}
                %
              </b>
            </span>
            <div className="occ-bar">
              <i
                style={{
                  width: `${all.length ? (busy / all.length) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        </div>
        <Tabs
          value={flt}
          onChange={setFlt}
          items={[
            ["all", `All Tables (${all.length})`],
            ...ST.map((s) => [s, `${labelOf(s)} (${counts[s] || 0})`]),
          ]}
        />
        {list.error && !list.data ? (
          <ErrorBox msg={list.error} retry={list.reloadFull} />
        ) : !list.data ? (
          <Loading />
        ) : !shown.length ? (
          <Empty icon="table" text="No tables found." />
        ) : view === "room" ? (
          <>
            {legend}
            <RoomView
              tables={all}
              shownKey={shown.map((t) => t.id).join(",")}
              sel={sel}
              onPick={setSel}
              cafeName={settings?.restaurant_name}
              fallback={floorGrid}
            />
          </>
        ) : view === "floor" ? (
          <>
            {legend}
            {floorGrid}
          </>
        ) : (
          <section className="card">
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Table</th>
                    <th>Seats</th>
                    <th>Status</th>
                    <th>Order</th>
                    <th>Since</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => (
                    <tr
                      key={t.id}
                      className={sel === t.id ? "sel" : ""}
                      onClick={() => setSel(t.id)}
                    >
                      <td>
                        <b>{t.name}</b>
                      </td>
                      <td>{t.capacity}</td>
                      <td>
                        <Badge v={t.status} />
                      </td>
                      <td>{t.order ? t.order.bill_no : "-"}</td>
                      <td>{fmtTime(t.status_since)}</td>
                      <td>{t.order ? money(t.order.total) : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        <h3 className="qa-t">Quick Actions</h3>
        <div className="qa">
          <button
            className="btn pri"
            onClick={needSel(() =>
              cur.status === "occupied"
                ? navigate(posPath, { orderId: cur.order.id })
                : cur.status === "out_of_service"
                  ? toast("Table is out of service.", "err")
                  : navigate(posPath, { tableId: cur.id }),
            )}
          >
            <Icon n="plus" /> Open Table
          </button>
          <button
            className="btn"
            onClick={needSel(() =>
              navigate(admin ? "/admin/orders" : "/orders"),
            )}
          >
            <Icon n="list" /> View Orders
          </button>
          <button
            className="btn"
            onClick={needSel(() =>
              setRes({ reserved_for: "", reserved_phone: "", reserved_at: "" }),
            )}
          >
            <Icon n="calendar" /> Reserve Table
          </button>
          <button className="btn" onClick={needSel(() => quick("cleaning"))}>
            <Icon n="sparkle" /> Mark Cleaning
          </button>
          <button className="btn" onClick={needSel(() => quick("available"))}>
            <Icon n="check" /> Mark Available
          </button>
          {can("tables.manage") && (
            <button
              className="btn"
              onClick={needSel(() => quick("out_of_service"))}
            >
              ⊘ Out of Service
            </button>
          )}
          {can("tables.manage") && (
            <button
              className="btn"
              onClick={needSel(() =>
                setForm({ id: cur.id, name: cur.name, capacity: cur.capacity }),
              )}
            >
              <Icon n="edit" /> Edit Table
            </button>
          )}
          {can("tables.manage") && (
            <button className="btn dng" onClick={needSel(del)}>
              <Icon n="trash" /> Delete
            </button>
          )}
        </div>
      </div>
      {sel && (
        <Detail
          id={sel}
          admin={admin}
          onClose={() => setSel(null)}
          refresh={list.reload}
        />
      )}
      {form && (
        <Modal
          title={form.id ? "Edit Table" : "New Table"}
          onClose={() => setForm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button className="btn pri" onClick={save}>
                Save Table
              </button>
            </>
          }
        >
          <Field
            label="Table name"
            req
            hint="Leave empty to create the next number automatically (T25, T26…)"
          >
            <input
              value={form.name}
              maxLength={50}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. T25"
            />
          </Field>
          <Field label="Seating capacity">
            <input
              type="number"
              min="1"
              max="50"
              value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            />
          </Field>
        </Modal>
      )}
      {res && (
        <Modal
          title={`Reserve ${cur?.name}`}
          onClose={() => setRes(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRes(null)}>
                Cancel
              </button>
              <button
                className="btn pri"
                onClick={async () => {
                  await quick("reserved", res);
                  setRes(null);
                }}
              >
                Reserve
              </button>
            </>
          }
        >
          <Field label="Customer name" req>
            <input
              value={res.reserved_for}
              onChange={(e) => setRes({ ...res, reserved_for: e.target.value })}
            />
          </Field>
          <Field label="Phone">
            <input
              value={res.reserved_phone}
              onChange={(e) =>
                setRes({ ...res, reserved_phone: e.target.value })
              }
            />
          </Field>
          <Field label="Date & time">
            <input
              type="datetime-local"
              value={res.reserved_at}
              onChange={(e) => setRes({ ...res, reserved_at: e.target.value })}
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}