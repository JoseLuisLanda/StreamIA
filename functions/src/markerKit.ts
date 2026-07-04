/**
 * generateMarkerKit -- SERVER-SIDE marker kit generation (feature /ar-assistant).
 *
 * Client-agnostic callable: ANY frontend calls
 * generateMarkerKit({ elementId, baseUrl, template? }) and receives Storage
 * paths of FIVE artifacts uploaded to ar-content/{elementId}/marker/:
 *
 *   qr.png       traditional QR encoding the viewer deep link
 *   marker.png   SQUARE tracking marker: WHITE outer margin (contorno blanco)
 *                + BLACK frame (recuadro negro, what AR.js locks onto) + inner
 *                art (color-bar design + QR + brand letters)
 *   label.png    VERTICAL LABEL (etiqueta, Publicar3D style): business LOGO
 *                zone on top (template.logoPath), short DESCRIPTION, and the
 *                square marker at the bottom
 *   marker.patt  ARToolKit pattern (16x16, BGR, 4 rotations) encoded from the
 *                SAME inner art, so print and tracking always match
 *   marker.pdf   letter sheet printing the LABEL at real size with crop marks
 *                + instructions
 *
 * Pipeline: qrcode -> SVG -> sharp -> pdf-lib (no node-canvas). AuthZ: owner or
 * admin (claim OR admins/{uid}), mirroring the rules. Template persisted on the
 * doc; colors validated (#rrggbb), texts XML-escaped, and logoPath is FORCED to
 * live under ar-content/{elementId}/ (no arbitrary bucket reads).
 * REGENERATION OVERWRITES in place: printed markers stop tracking if the art
 * changes -- the client confirms first.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db, bucket } from './admin';
import { assertSignedIn } from './lib/auth';
import * as QRCode from 'qrcode';
import sharp = require('sharp');
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const CALL_OPTS = { region: 'us-central1', cors: true, memory: '512MiB', timeoutSeconds: 120 } as const;

export interface MarkerTemplate {
  /** Black tracking frame color (keep near-black for detection). */
  borderColor?: string;
  /** Inner background (keep light for QR readability). */
  innerBackground?: string;
  /** Accent color of the bar design. Default derived from element id. */
  accentColor?: string;
  /** Label headline under the logo (default: element name). */
  title?: string;
  /** Short description printed ABOVE the marker box. */
  description?: string;
  /** Brand letters drawn inside the marker art (default 'P'). */
  brandText?: string;
  /** Corner text inside the marker art (default 'AR'). */
  cornerText?: string;
  /** Storage path of the business logo (MUST be under ar-content/{id}/). */
  logoPath?: string;
  /** Label header (logo + title + description zone) background color. */
  headerBackground?: string;
  /** Title + description text color over the header background. */
  headerTextColor?: string;
  /**
   * Inner-art fraction of the BLACK frame width (AR.js patternRatio).
   * Default 0.9 = THIN frame (1/3 of the classic 0.72 thickness): the inner
   * art EXPANDS OUTWARD; the outer white contour is untouched. The VIEWER
   * must configure the same patternRatio on the arjs scene (ar-scene.service
   * reads it from the element's markerTemplate).
   */
  patternRatio?: number;
}

interface GenerateReq {
  elementId: string;
  baseUrl: string;
  template?: MarkerTemplate;
}

interface GenerateRes {
  ok: true;
  deepLink: string;
  qrPath: string;
  markerPath: string;
  labelPath: string;
  patternPath: string;
  pdfPath: string;
}

const MARKER_PX = 2048;      // square marker artifact
const WHITE_MARGIN = 0.06;   // white contour fraction of marker width
const LABEL_W = 1600;        // vertical label
const LABEL_H = 2300;
const PATT_CELLS = 16;
const HEX = /^#[0-9a-fA-F]{6}$/;

export const generateMarkerKit = onCall<GenerateReq, Promise<GenerateRes>>(
  CALL_OPTS,
  async (req): Promise<GenerateRes> => {
    const uid = assertSignedIn(req.auth);
    const elementId = (req.data?.elementId ?? '').trim();
    if (!elementId) throw new HttpsError('invalid-argument', 'elementId requerido.');
    const baseUrl = normalizeBaseUrl(req.data?.baseUrl ?? '');

    const ref = db.collection('ar_elements').doc(elementId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'El elemento no existe.');
    const el = snap.data() as Record<string, unknown>;
    if (el['ownerUid'] !== uid) await assertAdminMirror(req.auth);

    const tpl = mergeTemplate(elementId, String(el['name'] ?? ''), el['markerTemplate'] as MarkerTemplate | undefined, req.data?.template);

    // ---- 1. QR (deep link) --------------------------------------------------
    const deepLink = `${baseUrl}/ar-assistant?element=${elementId}`;
    const qrPng = await QRCode.toBuffer(deepLink, {
      width: 1024, margin: 2, errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' },
    });

    // ---- 2. Inner art + square marker (white margin + black frame + inner) --
    const innerSvg = buildInnerSvg(tpl, qrPng);
    const whitePx = Math.round(MARKER_PX * WHITE_MARGIN);
    const blackPx = MARKER_PX - 2 * whitePx;
    const innerPx = Math.round(blackPx * tpl.patternRatio!);
    const innerPng = await sharp(Buffer.from(innerSvg)).resize(innerPx, innerPx, { fit: 'fill' }).png().toBuffer();

    const markerBaseSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${MARKER_PX}" height="${MARKER_PX}">` +
      `<rect width="${MARKER_PX}" height="${MARKER_PX}" fill="#ffffff"/>` +
      `<rect x="${whitePx}" y="${whitePx}" width="${blackPx}" height="${blackPx}" fill="${tpl.borderColor}"/>` +
      `</svg>`;
    const innerOffset = Math.round((MARKER_PX - innerPx) / 2);
    const markerPng = await sharp(Buffer.from(markerBaseSvg))
      .composite([{ input: innerPng, left: innerOffset, top: innerOffset }])
      .png()
      .toBuffer();

    // ---- 3. .patt from the inner art ----------------------------------------
    const patt = await encodePatt(innerPng);

    // ---- 4. Vertical label (logo + description + marker) --------------------
    const logoPng = await loadLogo(elementId, tpl.logoPath);
    const labelPng = await buildLabelPng(tpl, markerPng, logoPng);

    // ---- 5. PDF print sheet (prints the LABEL) -------------------------------
    const pdfBytes = await buildPdf(labelPng, tpl.title!, deepLink);

    // ---- 6. Upload (overwrite in place) --------------------------------------
    const base = `ar-content/${elementId}/marker`;
    const paths = {
      qrPath: `${base}/qr.png`,
      markerPath: `${base}/marker.png`,
      labelPath: `${base}/label.png`,
      patternPath: `${base}/marker.patt`,
      pdfPath: `${base}/marker.pdf`,
    };
    await Promise.all([
      bucket.file(paths.qrPath).save(qrPng, { contentType: 'image/png' }),
      bucket.file(paths.markerPath).save(markerPng, { contentType: 'image/png' }),
      bucket.file(paths.labelPath).save(labelPng, { contentType: 'image/png' }),
      bucket.file(paths.patternPath).save(Buffer.from(patt, 'ascii'), { contentType: 'text/plain' }),
      bucket.file(paths.pdfPath).save(Buffer.from(pdfBytes), { contentType: 'application/pdf' }),
    ]);

    // ---- 7. Patch the doc -----------------------------------------------------
    const patch: Record<string, unknown> = {
      qrImageUrl: paths.qrPath,
      markerImageUrl: paths.markerPath,
      labelImageUrl: paths.labelPath,
      markerPdfUrl: paths.pdfPath,
      // patternUrl is set for EVERY element type: the QR deep-link flow opens
      // the viewer in MARKER mode regardless of the element's own anchor
      // (a GPS element can still be experienced through its printed label).
      // Harmless for gps mode (ignored there); publishBlockers only demands
      // it for markerType 'pattern'.
      patternUrl: paths.patternPath,
      markerTemplate: tpl,
      markerKitGeneratedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await ref.set(patch, { merge: true });

    logger.info('[markerKit] generated', { elementId, by: uid, deepLink, logo: !!logoPng });
    return { ok: true, deepLink, ...paths };
  },
);

// ------------------------------------------------------------------ helpers

function normalizeBaseUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(url) && !/^http:\/\/localhost(:\d+)?$/.test(url)) {
    throw new HttpsError('invalid-argument', 'baseUrl invalida (https://host o http://localhost).');
  }
  return url;
}

async function assertAdminMirror(auth: { uid: string; token?: Record<string, unknown> } | undefined): Promise<void> {
  const token = (auth?.token ?? {}) as Record<string, unknown>;
  if (token['role'] === 'admin' || token['admin'] === true) return;
  try {
    const snap = await db.collection('admins').doc(auth!.uid).get();
    if (snap.exists && snap.get('disabled') !== true) return;
  } catch { /* fall through */ }
  throw new HttpsError('permission-denied', 'Solo el propietario o un admin puede generar el kit.');
}

function mergeTemplate(id: string, name: string, fromDoc?: MarkerTemplate, fromReq?: MarkerTemplate): Required<MarkerTemplate> {
  const t = {
    borderColor: '#000000',
    innerBackground: '#ffffff',
    accentColor: accentFromId(id),
    title: name || id,
    description: '',
    brandText: 'P',
    cornerText: 'AR',
    logoPath: '',
    headerBackground: '#ffffff',
    headerTextColor: '#111111',
    patternRatio: 0.9,
    ...(fromDoc ?? {}),
    ...(fromReq ?? {}),
  } as Required<MarkerTemplate>;
  if (!HEX.test(t.borderColor)) t.borderColor = '#000000';
  if (!HEX.test(t.innerBackground)) t.innerBackground = '#ffffff';
  if (!HEX.test(t.accentColor)) t.accentColor = accentFromId(id);
  if (!HEX.test(t.headerBackground)) t.headerBackground = '#ffffff';
  if (!HEX.test(t.headerTextColor)) t.headerTextColor = '#111111';
  t.title = String(t.title).slice(0, 48);
  t.description = String(t.description).slice(0, 160);
  t.brandText = String(t.brandText).slice(0, 3);
  t.cornerText = String(t.cornerText).slice(0, 4);
  t.logoPath = String(t.logoPath ?? '');
  // patternRatio: the DOC value is IGNORED on purpose (old docs persisted the
  // legacy thick-frame 0.72 and would override the new default forever). Only
  // an explicit REQUEST value wins; otherwise 0.8.
  // WHY 0.8 (not 0.9): ARToolKit finds the marker by its dark frame; below
  // ~10% border per side (ratio > ~0.8-0.85) detection becomes unreliable at
  // normal print sizes/distances. 0.8 keeps the frame visually thin while
  // still detectable; raise per-request at your own risk.
  const rReq = Number(fromReq?.patternRatio);
  t.patternRatio = Number.isFinite(rReq) && rReq >= 0.5 && rReq <= 0.9 ? rReq : 0.8;
  return t;
}

/** Load + normalize the business logo. SECURITY: only paths under this
 *  element's own folder are allowed (no arbitrary bucket reads). */
async function loadLogo(elementId: string, logoPath?: string): Promise<Buffer | null> {
  const p = (logoPath ?? '').trim();
  if (!p) return null;
  if (!p.startsWith(`ar-content/${elementId}/`)) {
    throw new HttpsError('invalid-argument', 'logoPath debe estar dentro de ar-content/{elementId}/.');
  }
  try {
    const [buf] = await bucket.file(p).download();
    // Normalize any input format to PNG, capped to the logo zone.
    return await sharp(buf).resize(1440, 420, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch (e) {
    logger.warn('[markerKit] logo unreadable, skipping', { logoPath: p, e: String(e) });
    return null;
  }
}

function accentFromId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return hslToHex(h % 360, 78, 45);
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100, ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = ln - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Inner art (1024 viewBox) with QR-STYLE ORIENTATION FINDERS: three bold dark
 * corner anchors (top-left, top-right, bottom-left) and ONE deliberately open
 * corner (bottom-right, light accent bracket). At the 16x16 .patt resolution
 * this breaks EVERY rotational symmetry with high contrast, so ARToolKit
 * locks the same orientation on every re-detection (no more random 180 flips
 * when tracking drops and recovers). QR centered; brand/corner text and
 * accent bars fill the space between finders.
 */
function buildInnerSvg(t: Required<MarkerTemplate>, qrPng: Buffer): string {
  const S = 1024;
  const qrSize = 500;
  const qrX = (S - qrSize) / 2;
  const qrY = (S - qrSize) / 2;
  const qrB64 = qrPng.toString('base64');
  const acc = t.accentColor;
  const RED = '#d92b2b', BLUE = '#1f6fd6', YEL = '#f2b01e';
  const F = 190; // finder outer size
  const M = 36;  // finder margin from the inner-art edge
  const DARK = '#111111';
  /** QR-like finder: dark square, white ring, dark core. */
  const finder = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="${F}" height="${F}" fill="${DARK}"/>` +
    `<rect x="${x + 30}" y="${y + 30}" width="${F - 60}" height="${F - 60}" fill="${t.innerBackground}"/>` +
    `<rect x="${x + 60}" y="${y + 60}" width="${F - 120}" height="${F - 120}" fill="${DARK}"/>`;
  const brX = S - M - F, brY = S - M - F; // open corner (bottom-right)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<rect width="${S}" height="${S}" fill="${t.innerBackground}"/>` +
    // three orientation finders + one OPEN corner (thin accent bracket only)
    finder(M, M) + finder(S - M - F, M) + finder(M, S - M - F) +
    `<path d="M ${brX + F} ${brY + F - 60} L ${brX + F} ${brY + F} L ${brX + F - 60} ${brY + F}" ` +
    `stroke="${acc}" stroke-width="16" fill="none"/>` +
    // corner text between the top finders
    `<text x="${S / 2}" y="150" text-anchor="middle" font-family="sans-serif" font-size="96" font-weight="700" fill="${BLUE}">${esc(t.cornerText)}</text>` +
    // brand letters at the bottom band (between BL finder and open corner)
    `<text x="${S / 2}" y="${S - 78}" text-anchor="middle" font-family="sans-serif" font-size="110" font-weight="800" fill="${YEL}">${esc(t.brandText)}</text>` +
    // side accent bars (left/right bands between finders)
    `<rect x="${M + 20}" y="380" width="34" height="264" fill="${acc}"/>` +
    `<rect x="${M + 74}" y="420" width="34" height="184" fill="${RED}"/>` +
    `<rect x="${S - M - 54}" y="380" width="34" height="264" fill="${BLUE}"/>` +
    `<rect x="${S - M - 108}" y="420" width="34" height="184" fill="${YEL}"/>` +
    // QR (own white quiet zone from margin:2)
    `<image x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" href="data:image/png;base64,${qrB64}"/>` +
    `</svg>`
  );
}

/** Wrap plain text into up to maxLines lines of ~maxChars. */
function wrapText(s: string, maxChars: number, maxLines: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      lines.push(cur.trim());
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur.trim());
  return lines.slice(0, maxLines);
}

/**
 * VERTICAL LABEL (etiqueta): HEADER rectangle (customizable background) with
 * the business logo + title + description in the header text color, then the
 * square marker at the bottom surrounded by a DASHED CUT LINE with a scissors
 * symbol (recorta aqui).
 */
async function buildLabelPng(t: Required<MarkerTemplate>, markerPng: Buffer, logoPng: Buffer | null): Promise<Buffer> {
  const descLines = wrapText(t.description, 44, 3);
  const logoB64 = logoPng ? logoPng.toString('base64') : '';
  const haveLogo = !!logoPng;

  // ---- outer CUT LINE: the WHOLE label is the cut area (header included) ----
  const CUT_M = 40; // dashed line inset from the label edges
  const CUTCOL = '#555555';
  const dashedRect =
    `<rect x="${CUT_M}" y="${CUT_M}" width="${LABEL_W - 2 * CUT_M}" height="${LABEL_H - 2 * CUT_M}" ` +
    `fill="none" stroke="${CUTCOL}" stroke-width="5" stroke-dasharray="22 16"/>`;
  // Scissors glyph ON the top dashed edge (white patch interrupts the dashes).
  const scX = CUT_M + 70, scY = CUT_M - 34;
  const scissors =
    `<g transform="translate(${scX},${scY})">` +
    `<rect x="-8" y="10" width="86" height="50" fill="#ffffff"/>` +
    `<g stroke="${CUTCOL}" stroke-width="6" fill="none" stroke-linecap="round">` +
    `<line x1="18" y1="16" x2="66" y2="52"/>` +
    `<line x1="18" y1="52" x2="66" y2="16"/>` +
    `<circle cx="12" cy="12" r="8"/>` +
    `<circle cx="12" cy="56" r="8"/>` +
    `</g></g>`;

  // ---- header (customizable background + text colors), inside the cut area --
  const headerRect = `<rect x="${CUT_M + 20}" y="${CUT_M + 20}" width="${LABEL_W - 2 * (CUT_M + 20)}" height="700" fill="${t.headerBackground}"/>`;
  const logoZone = haveLogo
    ? `<image x="100" y="${CUT_M + 40}" width="${LABEL_W - 200}" height="380" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${logoB64}"/>`
    : '';
  const titleY = haveLogo ? CUT_M + 540 : CUT_M + 280;
  const titleSize = haveLogo ? 72 : 110;
  const titleLine = `<text x="${LABEL_W / 2}" y="${titleY}" text-anchor="middle" font-family="sans-serif" font-size="${titleSize}" font-weight="800" fill="${t.headerTextColor}">${esc(t.title)}</text>`;
  const descStartY = haveLogo ? CUT_M + 615 : CUT_M + 400;
  const descSvg = descLines
    .map((ln, i) => `<text x="${LABEL_W / 2}" y="${descStartY + i * 58}" text-anchor="middle" font-family="sans-serif" font-size="46" fill="${t.headerTextColor}" opacity="0.82">${esc(ln)}</text>`)
    .join('');

  // ---- marker geometry (bottom, inside the cut area) ----
  const markerSize = 1400;
  const mkX = Math.round((LABEL_W - markerSize) / 2);
  const mkY = LABEL_H - markerSize - CUT_M - 40;

  const labelSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_W}" height="${LABEL_H}">` +
    `<rect width="${LABEL_W}" height="${LABEL_H}" fill="#ffffff"/>` +
    headerRect + logoZone + titleLine + descSvg + dashedRect + scissors +
    `</svg>`;

  const marker = await sharp(markerPng).resize(markerSize, markerSize).png().toBuffer();
  return sharp(Buffer.from(labelSvg))
    .composite([{ input: marker, left: mkX, top: mkY }])
    .png()
    .toBuffer();
}

/** ARToolKit .patt encoder (16x16, BGR, 4 rotations). */
async function encodePatt(innerPng: Buffer): Promise<string> {
  const blocks: string[] = [];
  for (const angle of [0, 90, 180, 270]) {
    const raw = await sharp(innerPng)
      .rotate(angle)
      .resize(PATT_CELLS, PATT_CELLS, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();
    const lines: string[] = [];
    for (const ch of [2, 1, 0]) {
      for (let y = 0; y < PATT_CELLS; y++) {
        const row: string[] = [];
        for (let x = 0; x < PATT_CELLS; x++) {
          row.push(String(raw[(y * PATT_CELLS + x) * 3 + ch]).padStart(3));
        }
        lines.push(row.join(' '));
      }
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

/** Letter sheet printing the LABEL (real size ~10x14.4 cm) + crop marks. */
async function buildPdf(labelPng: Buffer, name: string, deepLink: string): Promise<Uint8Array> {
  const CM = 28.3465;
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = await doc.embedPng(labelPng);

  const w = 10 * CM;
  const h = w * (LABEL_H / LABEL_W);
  const x = (612 - w) / 2;
  const y = 792 - 70 - h;

  page.drawText('Etiqueta RA: ' + name.slice(0, 48), { x: 54, y: 792 - 46, size: 14, font: bold, color: rgb(0.1, 0.1, 0.1) });
  page.drawImage(img, { x, y, width: w, height: h });

  const m = 14, g = 4, lw = 0.8;
  const mark = (cx: number, cy: number, dx: number, dy: number) => {
    page.drawLine({ start: { x: cx + dx * g, y: cy }, end: { x: cx + dx * (g + m), y: cy }, thickness: lw, color: rgb(0, 0, 0) });
    page.drawLine({ start: { x: cx, y: cy + dy * g }, end: { x: cx, y: cy + dy * (g + m) }, thickness: lw, color: rgb(0, 0, 0) });
  };
  mark(x, y + h, -1, 1); mark(x + w, y + h, 1, 1);
  mark(x, y, -1, -1); mark(x + w, y, 1, -1);

  const lines = [
    'Instrucciones: imprime al 100% en papel MATE, recorta por las guias,',
    'pega la etiqueta plana y bien iluminada. El visitante escanea el QR,',
    'inicia sesion y vuelve a apuntar al marcador cuadrado inferior.',
    'Enlace: ' + deepLink,
    'Si regeneras el kit, reimprime: el patron anterior deja de reconocerse.',
  ];
  let ty = y - 30;
  for (const ln of lines) {
    page.drawText(ln, { x: 54, y: ty, size: 9.5, font, color: rgb(0.15, 0.15, 0.15) });
    ty -= 14;
  }
  return doc.save();
}
