// Whole-café "3D room" floor plan.
// Pure functions -> one SVG string (no 3D library, no images), so it is light and works offline.
//
// The room has a wooden back wall (café name sign + lamps), a counter with a pastry display,
// plants, and every table drawn in a 3/4 view with chairs, guests and a glowing ring:
//   Available = no ring (green label)   Occupied = blue   Served = orange   Bill Pending = red
// In front of every guest there is a smartphone until the food is served, then a plate of food.

const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pick = (arr, n) => arr[Math.abs(Math.floor(n)) % arr.length];

const SHIRTS = ["#e03e3e", "#2b8be6", "#f08c00", "#8e44e8", "#12a67c", "#f2c200", "#e64980", "#3b5bdb"];
const SKINS = ["#f3cfae", "#e6b184", "#c98e5d", "#8d5a3b", "#f6dcc2"];
const HAIRS = ["#1b1b1f", "#4a2c17", "#7a4a21", "#b8702c", "#2b2b33"];
const FOODS = ["#e11d48", "#84cc16", "#f59e0b", "#fb923c", "#a3e635"];
const SCREENS = ["#60a5fa", "#38bdf8", "#818cf8", "#34d399"];

// ring = glow colour around the table, pill = label colour
const LOOK = {
  available: { ring: null, pill: "#16a34a" },
  occupied: { ring: "#3b82f6", pill: "#2563eb" },
  served: { ring: "#f59e0b", pill: "#d97706" },
  bill: { ring: "#ef4444", pill: "#dc2626" },
  reserved: { ring: "#a78bfa", pill: "#7c3aed", dash: true },
  cleaning: { ring: "#2dd4bf", pill: "#0d9488", dash: true },
  out_of_service: { ring: "#6b7280", pill: "#4b5563", dash: true },
};
const lookOf = (p) => LOOK[p] || LOOK.available;

/* ---------------------------------------------------------------- geometry */

// a = half width, b = half depth (on screen) of the table top
function sizeOf(shape, n) {
  const base = 44 + Math.min(n, 8) * 2.4;
  if (shape === "long") return { a: base * 1.25 + Math.max(0, n - 6) * 5, b: base * 0.42, r: 8 };
  if (shape === "square") return { a: base * 0.9, b: base * 0.9 * 0.58, r: 9 };
  return { a: base, b: base * 0.56, r: 0 };
}

// chair positions around the table. dx/dy = direction pointing away from the table
function seatList(shape, n, a, b) {
  const out = [];
  if (shape === "long") {
    const top = Math.ceil(n / 2);
    const bot = n - top;
    const xs = (cnt, j) => (cnt === 1 ? 0 : (((j + 0.5) / cnt) * 2 - 1) * a * 0.82);
    for (let j = 0; j < Math.max(top, bot); j++) {
      if (j < top) out.push({ x: xs(top, j), y: -(b + 16) + 3, dx: 0, dy: -1 });
      if (j < bot) out.push({ x: xs(bot, j), y: b + 16 + 3, dx: 0, dy: 1 });
    }
    return out;
  }
  const ex = shape === "round" ? 1 : 0.55;
  const sg = (v) => (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), ex);
  for (let i = 0; i < n; i++) {
    const th = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const c = Math.cos(th);
    const s = Math.sin(th);
    out.push({ x: (a + 19) * sg(c), y: (b + 15) * sg(s) + 3, dx: c, dy: s });
  }
  return out;
}

// which chairs get a guest: spread them around the table, not all on one side
function spread(n, g) {
  const k = Math.min(g, n);
  const idx = [];
  for (let i = 0; i < k; i++) idx.push(Math.min(n - 1, Math.floor((i * n) / k)));
  return idx;
}

const sideOf = (s) => (s.dy < -0.35 ? "b" : s.dy > 0.35 ? "f" : "s");

/* ------------------------------------------------------------- small parts */

function chairSvg(s) {
  const side = sideOf(s);
  const rest = `fill="#17171c" stroke="#3b3b46" stroke-width="1"`;
  const seat = `<ellipse cy="3" rx="15" ry="8.8" fill="#000" opacity=".28"/><ellipse rx="13.5" ry="8" fill="#26262e" stroke="#464652" stroke-width="1"/>`;
  let body;
  if (side === "b") body = `<rect x="-14" y="-14" width="28" height="9" rx="4.5" ${rest}/>${seat}`;
  else if (side === "f") body = `${seat}<rect x="-14" y="8" width="28" height="9" rx="4.5" ${rest}/>`;
  else body = `<rect x="${s.dx > 0 ? 9 : -17}" y="-10" width="8" height="19" rx="4" ${rest}/>${seat}`;
  return `<g transform="translate(${r1(s.x)} ${r1(s.y)})">${body}</g>`;
}

function personSvg(s, key) {
  const side = sideOf(s);
  const shirt = pick(SHIRTS, key);
  const skin = pick(SKINS, key * 3 + 1);
  const hair = pick(HAIRS, key * 5 + 2);
  const px = r1(s.x - s.dx * 4);
  const py = r1(s.y - 12 - s.dy * 2);
  const torso =
    `<ellipse cx="${px}" cy="${r1(py + 8)}" rx="11.5" ry="10" fill="${shirt}"/>` +
    `<ellipse cx="${px}" cy="${r1(py + 4.5)}" rx="8" ry="4.2" fill="#fff" opacity=".16"/>`;
  let head;
  if (side === "f") {
    // sitting with the back to us: we only see the hair
    head =
      `<circle cx="${px}" cy="${r1(py - 6)}" r="7.8" fill="${hair}"/>` +
      `<ellipse cx="${px}" cy="${r1(py - 8)}" rx="5" ry="2.4" fill="#fff" opacity=".12"/>`;
  } else {
    head =
      `<circle cx="${px}" cy="${r1(py - 6)}" r="7.6" fill="${skin}"/>` +
      `<path d="M${r1(px - 7.8)} ${r1(py - 7)}a7.8 7.8 0 0 1 15.6 0q-7.8 4.4 -15.6 0z" fill="${hair}"/>` +
      `<circle cx="${r1(px - 2.7)}" cy="${r1(py - 5)}" r=".9" fill="#2b2b2b" opacity=".75"/>` +
      `<circle cx="${r1(px + 2.7)}" cy="${r1(py - 5)}" r=".9" fill="#2b2b2b" opacity=".75"/>`;
  }
  return `<g>${torso}${head}</g>`;
}

function plateSvg(x, y, seed) {
  const f = (i) => pick(FOODS, seed + i);
  return (
    `<g transform="translate(${r1(x)} ${r1(y)})">` +
    `<ellipse cy="1.6" rx="11.5" ry="6.6" fill="#000" opacity=".3"/>` +
    `<ellipse rx="11" ry="6.2" fill="#f8f8f5" stroke="#d6d3d1" stroke-width=".8"/>` +
    `<ellipse rx="7.4" ry="4" fill="#efefe9"/>` +
    `<ellipse cx="-2.6" cy="-.4" rx="2.7" ry="1.7" fill="${f(0)}"/>` +
    `<ellipse cx="2.4" cy="-.9" rx="2.4" ry="1.5" fill="${f(1)}"/>` +
    `<ellipse cx=".4" cy="1.4" rx="2.3" ry="1.4" fill="${f(2)}"/></g>`
  );
}

function phoneSvg(x, y, seed) {
  const tilt = ((seed % 5) - 2) * 5;
  const hue = pick(SCREENS, seed);
  return (
    `<g transform="translate(${r1(x)} ${r1(y)}) rotate(${tilt})">` +
    `<rect x="-5.2" y="-3" width="10.4" height="7" rx="1.8" fill="#000" opacity=".3"/>` +
    `<rect x="-5.2" y="-3.6" width="10.4" height="7" rx="1.8" fill="#15151a" stroke="#9ca3af" stroke-width=".6"/>` +
    `<rect x="-4.2" y="-2.7" width="8.4" height="5.2" rx="1" fill="${hue}"/>` +
    `<path d="M-3 -1.2h6M-3 .4h4" stroke="#fff" stroke-width=".7" stroke-linecap="round" opacity=".85"/></g>`
  );
}

function vaseSvg() {
  return (
    `<g transform="translate(0 -1)"><ellipse cy="2" rx="4.4" ry="2" fill="#000" opacity=".3"/>` +
    `<rect x="-2.6" y="-6" width="5.2" height="8" rx="2" fill="#c8e6f5" opacity=".85" stroke="#8cc4de" stroke-width=".6"/>` +
    `<path d="M0 -6v-6" stroke="#3f9d52" stroke-width="1.2"/>` +
    `<circle cx="-3" cy="-13" r="2.6" fill="#fbbf24"/><circle cx="3" cy="-13.5" r="2.6" fill="#fb923c"/>` +
    `<circle cx="0" cy="-16" r="2.6" fill="#fde047"/></g>`
  );
}

function miniPlantSvg() {
  return (
    `<g transform="translate(0 -1)"><ellipse cy="2" rx="5.6" ry="2.2" fill="#000" opacity=".3"/>` +
    `<path d="M-4.6 -6h9.2l-1.4 8h-6.4z" fill="#b4541d"/>` +
    `<ellipse cx="-3.4" cy="-11" rx="2.4" ry="5.4" transform="rotate(-32 -3.4 -11)" fill="#2f8f46"/>` +
    `<ellipse cx="3.4" cy="-11" rx="2.4" ry="5.4" transform="rotate(32 3.4 -11)" fill="#3aa356"/>` +
    `<ellipse cx="0" cy="-13" rx="2.4" ry="6" fill="#4cbd68"/></g>`
  );
}

function receiptSvg() {
  return (
    `<g transform="translate(0 -3) rotate(-8)">` +
    `<rect x="-9" y="-9" width="18" height="18" rx="1.6" fill="#000" opacity=".3" transform="translate(1.2 1.6)"/>` +
    `<rect x="-9" y="-9" width="18" height="18" rx="1.6" fill="#fff" stroke="#e5e7eb" stroke-width=".6"/>` +
    `<rect x="-9" y="-9" width="18" height="4.4" rx="1.6" fill="#ef4444"/>` +
    `<path d="M-6 -1.6h12M-6 1.6h12M-6 4.8h7" stroke="#6b7280" stroke-width="1.1" stroke-linecap="round"/></g>`
  );
}

function tentCardSvg() {
  return (
    `<g transform="translate(0 -1)"><path d="M-7 3l2-9h10l2 9z" fill="#fff" stroke="#c4b5fd" stroke-width=".8"/>` +
    `<path d="M-5.4 -.6h10.8" stroke="#7c3aed" stroke-width="1.6" stroke-linecap="round"/></g>`
  );
}

/* ------------------------------------------------------------------- table */

function tableSvg(t, sc) {
  const look = lookOf(t.phase);
  const n = Math.max(1, Math.min(Number(t.capacity) || 4, 10));
  const shape = t.shape || "round";
  const { a, b, r } = sizeOf(shape, n);
  const TH = 9;
  const seats = seatList(shape, n, a, b);
  const guests = Math.max(0, Math.min(Number(t.guests) || 0, n));
  const seated = spread(seats.length, guests);
  const food = t.phase === "served" || t.phase === "bill";
  const seed = Number(t.id) || 1;

  // glow ring + soft light on the floor
  const rx = a + 46;
  const ry = b + 34;
  let glow = `<ellipse cy="${r1(b * 0.5 + 6)}" rx="${r1(a + 30)}" ry="${r1(b + 26)}" fill="#000" opacity=".28"/>`;
  if (look.ring) {
    const dash = look.dash ? ` stroke-dasharray="7 6"` : "";
    glow =
      `<ellipse cy="4" rx="${r1(rx + 16)}" ry="${r1(ry + 12)}" fill="${look.ring}" opacity=".14"/>` +
      `<ellipse class="rm-ring" cy="4" rx="${r1(rx)}" ry="${r1(ry)}" fill="none" stroke="${look.ring}" stroke-width="6" opacity=".85" filter="url(#rmBlur)"${dash}/>` +
      `<ellipse cy="4" rx="${r1(rx)}" ry="${r1(ry)}" fill="none" stroke="${look.ring}" stroke-width="2.4"${dash}/>`;
  }
  if (t.selected) {
    glow += `<ellipse cy="4" rx="${r1(rx + 9)}" ry="${r1(ry + 8)}" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="6 5" opacity=".9"/>`;
  }

  // table body
  let body;
  if (shape === "round") {
    body =
      `<ellipse cy="${TH}" rx="${r1(a)}" ry="${r1(b)}" fill="#0a0a0d"/>` +
      `<rect x="${r1(-a)}" y="0" width="${r1(a * 2)}" height="${TH}" fill="#0a0a0d"/>` +
      `<path d="M${r1(-a)} 0v${TH}a${r1(a)} ${r1(b)} 0 0 0 ${r1(a * 2)} 0v-${TH}" fill="none" stroke="#b8862b" stroke-width="1.2" opacity=".8"/>` +
      `<ellipse rx="${r1(a)}" ry="${r1(b)}" fill="url(#rmTop)" stroke="#d9a93f" stroke-width="2.4"/>` +
      `<path d="M${r1(-a * 0.55)} ${r1(b * 0.1)}q${r1(a * 0.35)} ${r1(-b * 0.5)} ${r1(a * 0.8)} ${r1(-b * 0.25)}` +
      `M${r1(a * 0.1)} ${r1(b * 0.45)}q${r1(a * 0.3)} ${r1(-b * 0.2)} ${r1(a * 0.55)} ${r1(-b * 0.15)}" fill="none" stroke="#fff" stroke-width="1" opacity=".12"/>` +
      `<ellipse cx="${r1(-a * 0.3)}" cy="${r1(-b * 0.4)}" rx="${r1(a * 0.35)}" ry="${r1(b * 0.14)}" fill="#fff" opacity=".07"/>`;
  } else {
    body =
      `<rect x="${r1(-a)}" y="${r1(-b + TH)}" width="${r1(a * 2)}" height="${r1(b * 2)}" rx="${r}" fill="#0a0a0d"/>` +
      `<rect x="${r1(-a)}" y="${r1(-b)}" width="${r1(a * 2)}" height="${r1(b * 2)}" rx="${r}" fill="url(#rmTop)" stroke="#d9a93f" stroke-width="2.4"/>` +
      `<path d="M${r1(-a * 0.7)} ${r1(b * 0.3)}l${r1(a * 0.5)} ${r1(-b * 0.5)}" stroke="#fff" stroke-width="1" opacity=".1" fill="none"/>` +
      `<rect x="${r1(-a * 0.85)}" y="${r1(-b * 0.82)}" width="${r1(a * 0.9)}" height="${r1(b * 0.28)}" rx="3" fill="#fff" opacity=".06"/>`;
  }

  // things on the table
  let items = "";
  seated.forEach((si, k) => {
    const s = seats[si];
    const ix = (s.x * (a * 0.58)) / (a + 19);
    const iy = ((s.y - 3) * (b * 0.58)) / (b + 15);
    items += food ? plateSvg(ix, iy, seed + k + si) : phoneSvg(ix, iy, seed + k + si);
  });
  if (t.phase === "bill") items += receiptSvg();
  else if (t.phase === "reserved") items += tentCardSvg();
  else if (t.phase === "available" || t.phase === "cleaning" || t.phase === "out_of_service") items += miniPlantSvg();
  else items += vaseSvg();

  // chairs + guests. Back row is drawn before the table, the rest after it.
  const order = seats.map((s, i) => ({ s, i })).sort((p, q) => p.s.y - q.s.y);
  const seatedSet = new Set(seated);
  const part = (list) =>
    list
      .map(({ s, i }) => chairSvg(s) + (seatedSet.has(i) ? personSvg(s, seed * 7 + i * 3) : ""))
      .join("");
  const backSide = order.filter(({ s }) => sideOf(s) === "b");
  const frontSide = order.filter(({ s }) => sideOf(s) !== "b");

  // label under the table
  const label = `${t.label}${t.guests > 0 ? ` (${t.guests})` : ""}`;
  const pw = Math.max(70, label.length * 6.6 + 34);
  const ly = ry + 26;
  const text =
    `<text y="${r1(ly)}" text-anchor="middle" font-size="17" font-weight="800" fill="#fff" stroke="#07100b" stroke-width="3.2" paint-order="stroke" stroke-linejoin="round">${esc(t.name)}</text>` +
    `<rect x="${r1(-pw / 2)}" y="${r1(ly + 8)}" width="${r1(pw)}" height="21" rx="10.5" fill="${look.pill}" stroke="#fff" stroke-opacity=".28"/>` +
    `<circle cx="${r1(-pw / 2 + 11)}" cy="${r1(ly + 18.5)}" r="3.2" fill="#fff"/>` +
    `<text x="4" y="${r1(ly + 22.6)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#fff">${esc(label)}</text>` +
    (t.sub
      ? `<text y="${r1(ly + 45)}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#e7efe9" stroke="#07100b" stroke-width="3" paint-order="stroke">${esc(t.sub)}</text>`
      : "");

  const op = t.phase === "out_of_service" ? 0.55 : 1;
  return (
    `<g class="rm-t ${esc(t.phase)}${t.selected ? " on" : ""}" data-tid="${esc(t.id)}" tabindex="0" role="button" aria-label="${esc(t.name)} - ${esc(label)}" ` +
    `transform="translate(${r1(t.x)} ${r1(t.y)}) scale(${r1(sc * 100) / 100})" opacity="${t.dim ? 0.28 : op}">` +
    `<g class="rm-in">${glow}${part(backSide)}${body}${items}${part(frontSide)}${text}</g></g>`
  );
}

/* -------------------------------------------------------------- room decor */

function plantSvg(x, y, s = 1) {
  return (
    `<g transform="translate(${r1(x)} ${r1(y)}) scale(${s})">` +
    `<ellipse cy="15" rx="17" ry="5" fill="#000" opacity=".3"/>` +
    `<ellipse cx="-12" cy="-16" rx="6" ry="18" transform="rotate(-38 -12 -16)" fill="#2f8f46"/>` +
    `<ellipse cx="12" cy="-16" rx="6" ry="18" transform="rotate(38 12 -16)" fill="#3aa356"/>` +
    `<ellipse cx="-5" cy="-24" rx="5.6" ry="19" transform="rotate(-14 -5 -24)" fill="#43b25f"/>` +
    `<ellipse cx="6" cy="-26" rx="5.6" ry="19" transform="rotate(14 6 -26)" fill="#2c8a43"/>` +
    `<ellipse cx="0" cy="-28" rx="5" ry="20" fill="#56c872"/>` +
    `<path d="M-11 -2h22l-3.4 17h-15.2z" fill="#b4541d"/><path d="M-11 -2h22l-.6 3.4h-20.8z" fill="#d06a2b"/></g>`
  );
}

function lampSvg(x, drop) {
  return (
    `<g transform="translate(${r1(x)} 0)">` +
    `<circle cy="${drop + 16}" r="54" fill="url(#rmLamp)"/>` +
    `<path d="M0 0V${drop}" stroke="#14100c" stroke-width="2"/>` +
    `<path d="M-15 ${drop + 18}q15 -26 30 0z" fill="#f5b544"/>` +
    `<ellipse cy="${drop + 18}" rx="15" ry="3.4" fill="#ffe7a3"/></g>`
  );
}

function counterSvg(x, y) {
  // pastry counter on the left side of the room
  const cakes = [
    ["#d9923b", 42], ["#f4b7c8", 66], ["#8a4b2a", 90], ["#f7d88a", 114],
  ];
  let sweets = "";
  cakes.forEach(([c, cx], i) => {
    sweets += `<ellipse cx="${cx}" cy="${y + 78}" rx="9" ry="6" fill="${c}"/><ellipse cx="${cx}" cy="${y + 74}" rx="5" ry="2.6" fill="#fff" opacity=".35"/>`;
    sweets += `<ellipse cx="${cx - (i % 2 ? 3 : 0)}" cy="${y + 108}" rx="${i % 2 ? 8 : 10}" ry="5.4" fill="${cakes[(i + 2) % 4][0]}"/>`;
  });
  return (
    `<ellipse cx="${x + 70}" cy="${y + 232}" rx="86" ry="12" fill="#000" opacity=".35"/>` +
    `<rect x="${x}" y="${y + 18}" width="140" height="210" rx="12" fill="#3a2415" stroke="#6b4423" stroke-width="2"/>` +
    `<rect x="${x - 8}" y="${y}" width="156" height="22" rx="10" fill="#8a5a33"/>` +
    `<rect x="${x - 8}" y="${y}" width="156" height="7" rx="3.5" fill="#fff" opacity=".14"/>` +
    `<rect x="${x + 98}" y="${y - 26}" width="34" height="26" rx="4" fill="#15151a" stroke="#4b5563"/>` +
    `<rect x="${x + 102}" y="${y - 22}" width="26" height="14" rx="2" fill="#38bdf8" opacity=".8"/>` +
    `<rect x="${x + 16}" y="${y + 44}" width="108" height="92" rx="8" fill="#cfe9ff" opacity=".2" stroke="#9ccaff" stroke-width="1.5"/>` +
    `<path d="M${x + 16} ${y + 92}h108" stroke="#9ccaff" stroke-width="1.5" opacity=".6"/>` +
    sweets +
    `<rect x="${x + 16}" y="${y + 150}" width="108" height="58" rx="6" fill="#1e120a"/>` +
    `<circle cx="${x + 36}" cy="${y + 178}" r="8" fill="#d9a93f" opacity=".85"/>` +
    `<circle cx="${x + 70}" cy="${y + 178}" r="8" fill="#d9a93f" opacity=".6"/>` +
    `<circle cx="${x + 104}" cy="${y + 178}" r="8" fill="#d9a93f" opacity=".85"/>`
  );
}

function shelfSvg(x, y) {
  const bottles = ["#7c3aed", "#16a34a", "#f59e0b", "#e11d48", "#0ea5e9", "#a3e635"];
  let s = `<rect x="${x}" y="${y}" width="210" height="6" rx="2" fill="#6b4423"/><rect x="${x}" y="${y + 52}" width="210" height="6" rx="2" fill="#6b4423"/>`;
  bottles.forEach((c, i) => {
    s += `<rect x="${x + 12 + i * 32}" y="${y - 26}" width="12" height="26" rx="4" fill="${c}" opacity=".9"/><rect x="${x + 15 + i * 32}" y="${y - 32}" width="6" height="8" rx="2" fill="${c}"/>`;
    s += `<rect x="${x + 10 + i * 32}" y="${y + 30}" width="16" height="22" rx="3" fill="#e7d3b4" opacity=".92"/>`;
  });
  return s;
}

function wallSvg(W, wallH, cafeName) {
  const name = String(cafeName || "Café").trim() || "Café";
  const fs = Math.max(18, Math.min(34, 34 - Math.max(0, name.length - 12) * 1.15));
  let panels = "";
  for (let x = 0; x < W; x += 46) {
    panels += `<rect x="${x}" y="0" width="3" height="${wallH}" fill="#000" opacity=".22"/><rect x="${x + 3}" y="0" width="1.4" height="${wallH}" fill="#fff" opacity=".05"/>`;
  }
  return (
    `<rect width="${W}" height="${wallH}" fill="url(#rmWall)"/>${panels}` +
    `<rect y="${wallH - 14}" width="${W}" height="14" fill="#1b0f07"/>` +
    `<rect y="${wallH - 15}" width="${W}" height="2" fill="#d9a93f" opacity=".5"/>` +
    // sign
    `<rect x="190" y="30" width="330" height="92" rx="12" fill="#1a110a" stroke="#d9a93f" stroke-width="3"/>` +
    `<rect x="198" y="38" width="314" height="76" rx="8" fill="none" stroke="#d9a93f" stroke-width="1" opacity=".5"/>` +
    `<text x="355" y="${r1(78 + fs * 0.12)}" text-anchor="middle" font-size="${fs}" font-weight="800" fill="#fdf2d6" font-family="Georgia, 'Times New Roman', serif">${esc(name)}</text>` +
    `<text x="355" y="104" text-anchor="middle" font-size="13" letter-spacing="3" fill="#d9a93f">CAFÉ &amp; RESTAURANT</text>` +
    shelfSvg(W - 300, 64) +
    lampSvg(120, 34) + lampSvg(W * 0.36, 30) + lampSvg(W * 0.52, 30) + lampSvg(W * 0.7, 34) + lampSvg(W - 70, 34)
  );
}

function floorSvg(W, H, wallH) {
  let seams = "";
  for (let k = -9; k <= 9; k++) {
    seams += `<line x1="${r1(W / 2 + k * 64)}" y1="${wallH}" x2="${r1(W / 2 + k * 64 * 1.28)}" y2="${H}" stroke="#000" stroke-opacity=".22" stroke-width="1.4"/>`;
  }
  let joints = "";
  const rows = 15;
  for (let i = 1; i < rows; i++) {
    const y = wallH + (H - wallH) * Math.pow(i / rows, 1.25);
    joints += `<line x1="0" y1="${r1(y)}" x2="${W}" y2="${r1(y)}" stroke="#fff" stroke-opacity=".035" stroke-width="1.6"/>`;
  }
  return (
    `<g clip-path="url(#rmFloorClip)"><rect y="${wallH}" width="${W}" height="${H - wallH}" fill="url(#rmFloor)"/>${seams}${joints}` +
    `<rect y="${wallH}" width="${W}" height="${H - wallH}" fill="url(#rmVig)"/></g>`
  );
}

function defsSvg(W, H, wallH) {
  return (
    `<defs>` +
    `<linearGradient id="rmWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a170b"/><stop offset="1" stop-color="#4b2d18"/></linearGradient>` +
    `<linearGradient id="rmFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c1c11"/><stop offset="1" stop-color="#4a3020"/></linearGradient>` +
    `<radialGradient id="rmVig" cx=".5" cy=".5" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></radialGradient>` +
    `<radialGradient id="rmLamp"><stop offset="0" stop-color="#ffd37a" stop-opacity=".55"/><stop offset="1" stop-color="#ffd37a" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="rmTop" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#3a3a44"/><stop offset="1" stop-color="#0e0e12"/></radialGradient>` +
    `<filter id="rmBlur" x="-30%" y="-40%" width="160%" height="180%"><feGaussianBlur stdDeviation="5"/></filter>` +
    `<clipPath id="rmFloorClip"><rect y="${wallH}" width="${W}" height="${H - wallH}"/></clipPath>` +
    `</defs>`
  );
}

/* ------------------------------------------------------------- whole room */

// tables: [{ id, name, capacity, shape, phase, label, guests, sub, dim }]
export function buildRoom({ tables = [], selected = null, cafeName = "" } = {}) {
  const W = 1240;
  const wallH = 170;
  const left = 190;
  const right = 70;
  const n = tables.length;
  const cols = n <= 4 ? Math.max(1, n) : n <= 6 ? 3 : n <= 12 ? 4 : 5;
  const rows = Math.max(1, Math.ceil(n / cols));
  const regionW = W - left - right;
  const colSp = regionW / cols;
  // shrink the tables a little when many wide tables share one row, so glow rings never touch
  const widest = tables.reduce((m, t) => {
    const nn = Math.max(1, Math.min(Number(t.capacity) || 4, 10));
    return Math.max(m, 2 * (sizeOf(t.shape || "round", nn).a + 46) + 10);
  }, 190);
  const k = Math.max(0.55, Math.min(1, colSp / widest));
  const rowH = 208 * Math.max(0.82, k);
  const rowY = (r) => wallH + 122 + r * rowH;
  const H = Math.round(rowY(rows - 1) + 150);

  let tablesSvg = "";
  let plants = "";
  tables.forEach((t, i) => {
    const r = Math.floor(i / cols);
    const j = i % cols;
    const cnt = Math.min(cols, n - r * cols);
    const x = left + regionW / 2 + (j - (cnt - 1) / 2) * colSp;
    const depth = k * (0.9 + 0.1 * (rows > 1 ? r / (rows - 1) : 1));
    tablesSvg += tableSvg({ ...t, x, y: rowY(r), selected: selected != null && t.id === selected }, depth);
  });
  for (let r = 0; r < rows; r++) {
    plants += plantSvg(W - 38, rowY(r) + 8, 1.05);
    if (r >= 1) plants += plantSvg(left - 34, rowY(r) + 8, 1.05);
  }
  plants += plantSvg(left - 22, wallH + 44, 0.95);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Café floor plan">` +
    defsSvg(W, H, wallH) +
    `<rect width="${W}" height="${H}" fill="#0b1510"/>` +
    floorSvg(W, H, wallH) +
    wallSvg(W, wallH, cafeName) +
    counterSvg(24, wallH + 34) +
    plants +
    tablesSvg +
    `</svg>`;
  return { svg, width: W, height: H };
}

export const ROOM_CSS = `
.rm-wrap{position:relative;border-radius:18px;overflow-x:auto;overflow-y:hidden;background:#0b1510;border:1px solid rgba(255,255,255,.08);box-shadow:0 14px 40px rgba(0,0,0,.28)}
.rm-wrap svg{display:block;width:100%;min-width:820px;height:auto}
.rm-t{cursor:pointer;outline:none}
.rm-t .rm-in{transition:transform .18s ease}
.rm-t:hover .rm-in,.rm-t:focus-visible .rm-in{transform:scale(1.045)}
.rm-ring{animation:rmPulse 2.6s ease-in-out infinite}
@keyframes rmPulse{0%,100%{opacity:.6}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.rm-ring{animation:none}.rm-t .rm-in{transition:none}}
`;