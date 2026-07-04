/**
 * generateMarkerKit -- SERVER-SIDE marker kit generation (feature /ar-assistant).
 *
 * Client-agnostic callable: ANY frontend (Angular manager, future apps) calls
 * generateMarkerKit({ elementId, baseUrl, template? }) and gets back the
 * Storage paths of four artifacts uploaded to ar-content/{elementId}/marker/:
 *
 *   qr.png       traditional QR encoding the viewer deep link
 *                ({baseUrl}/ar-assistant?element={id})
 *   marker.png   PRINTABLE custom marker: high-contrast border + inner art
 *                (QR + title + accent marks) -- the "envoltorio". 2048x2048.
 *   marker.patt  ARToolKit pattern file encoding the marker's INNER image
 *                (16x16 cells, 3 channels BGR, 4 rotations) -- what AR.js
 *                tracks. Generated from the same composition, so the printed
 *                marker and the .patt always match.
 *   marker.pdf   Letter-size print sheet: the marker at 10 cm with crop marks
 *                + usage instructions + the deep link.
 *
 * Pipeline: qrcode (QR buffer) -> SVG template -> sharp (rasterize PNG +
 * 16x16 raw sampling for the .patt) -> pdf-lib (print sheet). No node-canvas.
 *
 * AuthZ: owner (ar_elements/{id}.ownerUid == caller) or admin (claim OR
 * admins/{uid} allowlist) -- mirrors firestore.rules; enforced here because the
 * Admin SDK bypasses rules.
 *
 * Template: defaults <- element.markerTemplate <- request.template (merged and
 * PERSISTED on the doc so regeneration is stable). Colors are validated
 * (#rrggbb) and texts XML-escaped (the SVG is built from user input).
 *
 * REGENERATION OVERWRITES the same paths (decision): previously printed
 * markers stop tracking if the art changes -- the client must warn.
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
  /** Marker border color (high contrast vs environment). Default #000000. */
  borderColor?: string;
  /** Inner background. Default #ffffff (keeps the QR readable). */
  innerBackground?: string;
  /** Accent color for the distinctiveness marks. Default derived from id. */
  accentColor?: string;
  /** Title inside the marker. Default: element name. */
  title?: string;
  /** Small line under the QR. Default: 'Escaneame para ver en RA'. */
  subtitle?: string;
  /** Brand text at the bottom. Default: 'AR'. */
  brandText?: string;
  /** Inner-image fraction of the marker width (AR.js patternRatio). Default 0.5. */
  patternRatio?: number;
}

interface GenerateReq {
  elementId: string;
  /** Client origin for the deep link, e.g. https://strimearia.web.app */
  baseUrl: string;
  template?: MarkerTemplate;
}

interface GenerateRes {
  ok: true;
  deepLink: string;
  qrPath: string;
  markerPath: string;
  patternPath: string;
  pdfPath: string;
}

const SIZE = 2048;          // printable marker PNG size
const PATT_CELLS = 16;      // ARToolKit pattern resolution
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

    // ---- 1. QR (deep link) -------------------------------------------------
    const deepLink = `${baseUrl}/ar-assistant?element=${elementId}`;
    const qrPng = await QRCode.toBuffer(deepLink, {
      width: 1024,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' },
    });

    // ---- 2. Marker composition (SVG -> PNG) --------------------------------
    const innerSvg = buildInnerSvg(tpl, qrPng);
    const ratio = tpl.patternRatio!;
    const innerSize = Math.round(SIZE * ratio);
    const innerPng = await sharp(Buffer.from(innerSvg)).resize(innerSize, innerSize, { fit: 'fill' }).png().toBuffer();

    const markerSvg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
      `<rect width="${SIZE}" height="${SIZE}" fill="${tpl.borderColor}"/>` +
      `</svg>`;
    const markerPng = await sharp(Buffer.from(markerSvg))
      .composite([{ input: innerPng, left: Math.round((SIZE - innerSize) / 2), top: Math.round((SIZE - innerSize) / 2) }])
      .png()
      .toBuffer();

    // ---- 3. .patt from the inner image --------------------------------------
    const patt = await encodePatt(innerPng);

    // ---- 4. PDF print sheet --------------------------------------------------
    const pdfBytes = await buildPdf(markerPng, String(el['name'] ?? elementId), deepLink);

    // ---- 5. Upload (overwrite in place) --------------------------------------
    const base = `ar-content/${elementId}/marker`;
    const paths = {
      qrPath: `${base}/qr.png`,
      markerPath: `${base}/marker.png`,
      patternPath: `${base}/marker.patt`,
      pdfPath: `${base}/marker.pdf`,
    };
    await Promise.all([
      bucket.file(paths.qrPath).save(qrPng, { contentType: 'image/png' }),
      bucket.file(paths.markerPath).save(markerPng, { contentType: 'image/png' }),
      bucket.file(paths.patternPath).save(Buffer.from(patt, 'ascii'), { contentType: 'text/plain' }),
      bucket.file(paths.pdfPath).save(Buffer.from(pdfBytes), { contentType: 'application/pdf' }),
    ]);

    // ---- 6. Patch the doc -----------------------------------------------------
    const patch: Record<string, unknown> = {
      qrImageUrl: paths.qrPath,
      markerImageUrl: paths.markerPath,
      markerPdfUrl: paths.pdfPath,
      markerTemplate: tpl,
      markerKitGeneratedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (el['markerType'] === 'pattern') patch['patternUrl'] = paths.patternPath;
    await ref.set(patch, { merge: true });

    logger.info('[markerKit] generated', { elementId, by: uid, deepLink });
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

/** Admin mirror of firestore.rules isAdmin() (claim OR admins/{uid} doc). */
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
  const t: Required<MarkerTemplate> = {
    borderColor: '#000000',
    innerBackground: '#ffffff',
    accentColor: accentFromId(id),
    title: name || id,
    subtitle: 'Escaneame para ver en RA',
    brandText: 'AR',
    patternRatio: 0.5,
    ...(fromDoc ?? {}),
    ...(fromReq ?? {}),
  } as Required<MarkerTemplate>;
  if (!HEX.test(t.borderColor)) t.borderColor = '#000000';
  if (!HEX.test(t.innerBackground)) t.innerBackground = '#ffffff';
  if (!HEX.test(t.accentColor)) t.accentColor = accentFromId(id);
  t.title = String(t.title).slice(0, 40);
  t.subtitle = String(t.subtitle).slice(0, 60);
  t.brandText = String(t.brandText).slice(0, 20);
  const r = Number(t.patternRatio);
  t.patternRatio = Number.isFinite(r) && r >= 0.3 && r <= 0.9 ? r : 0.5;
  return t;
}

/** Deterministic vivid accent color from the element id (distinctiveness). */
function accentFromId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hslToHex(hue, 78, 45);
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
 * Inner art of the marker (1024 viewBox): background, corner accent marks,
 * title, embedded QR (data URI), subtitle, brand. Text uses generic sans-serif
 * (runtime fonts); layout keeps a white quiet zone around the QR.
 */
function buildInnerSvg(t: Required<MarkerTemplate>, qrPng: Buffer): string {
  const S = 1024;
  const qrSize = 560;
  const qrX = (S - qrSize) / 2;
  const qrY = 190;
  const qrB64 = qrPng.toString('base64');
  const acc = t.accentColor;
  const corner = (x: number, y: number, rot: number) =>
    `<g transform="translate(${x},${y}) rotate(${rot})">` +
    `<rect x="0" y="0" width="120" height="26" fill="${acc}"/>` +
    `<rect x="0" y="0" width="26" height="120" fill="${acc}"/></g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<rect width="${S}" height="${S}" fill="${t.innerBackground}"/>` +
    corner(36, 36, 0) + corner(S - 36, 36, 90) + corner(S - 36, S - 36, 180) + corner(36, S - 36, 270) +
    `<text x="${S / 2}" y="120" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="700" fill="#111111">${esc(t.title)}</text>` +
    `<image x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" href="data:image/png;base64,${qrB64}"/>` +
    `<text x="${S / 2}" y="${qrY + qrSize + 70}" text-anchor="middle" font-family="sans-serif" font-size="40" fill="#333333">${esc(t.subtitle)}</text>` +
    `<text x="${S / 2}" y="${S - 48}" text-anchor="middle" font-family="sans-serif" font-size="48" font-weight="700" fill="${acc}">${esc(t.brandText)}</text>` +
    `</svg>`
  );
}

/**
 * ARToolKit .patt encoder: the inner image sampled at 16x16, three channels in
 * BGR order, four rotations (0/90/180/270) separated by a blank line. Format
 * compatible with AR.js pattern markers (whitespace-tolerant parser).
 */
async function encodePatt(innerPng: Buffer): Promise<string> {
  const blocks: string[] = [];
  for (const angle of [0, 90, 180, 270]) {
    const raw = await sharp(innerPng)
      .rotate(angle)
      .resize(PATT_CELLS, PATT_CELLS, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer(); // RGB, 16*16*3
    const lines: string[] = [];
    for (const ch of [2, 1, 0]) { // B, G, R
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

/** Letter print sheet: centered marker at 10 cm, crop marks, instructions. */
async function buildPdf(markerPng: Buffer, name: string, deepLink: string): Promise<Uint8Array> {
  const CM = 28.3465; // pt per cm
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = await doc.embedPng(markerPng);

  const size = 10 * CM;
  const x = (612 - size) / 2;
  const y = 792 - 120 - size;

  page.drawText('Marcador RA: ' + name.slice(0, 48), { x: 54, y: 792 - 64, size: 16, font: bold, color: rgb(0.1, 0.1, 0.1) });
  page.drawImage(img, { x, y, width: size, height: size });

  // Crop marks (outside each corner).
  const m = 14, g = 4, w = 0.8;
  const mark = (cx: number, cy: number, dx: number, dy: number) => {
    page.drawLine({ start: { x: cx + dx * g, y: cy }, end: { x: cx + dx * (g + m), y: cy }, thickness: w, color: rgb(0, 0, 0) });
    page.drawLine({ start: { x: cx, y: cy + dy * g }, end: { x: cx, y: cy + dy * (g + m) }, thickness: w, color: rgb(0, 0, 0) });
  };
  mark(x, y + size, -1, 1); mark(x + size, y + size, 1, 1);
  mark(x, y, -1, -1); mark(x + size, y, 1, -1);

  const lines = [
    'Instrucciones:',
    '1. Imprime esta hoja al 100% (sin ajustar a pagina) en papel MATE.',
    '2. Recorta por las guias de las esquinas (el borde oscuro debe quedar completo).',
    '3. Pega el marcador plano, bien iluminado y sin reflejos.',
    '4. El visitante escanea el QR, inicia sesion y vuelve a apuntar al marcador.',
    '',
    'Enlace del contenido: ' + deepLink,
    'Si regeneras el kit, reimprime: el patron anterior deja de reconocerse.',
  ];
  let ty = y - 44;
  for (const ln of lines) {
    page.drawText(ln, { x: 54, y: ty, size: 10.5, font, color: rgb(0.15, 0.15, 0.15) });
    ty -= 16;
  }
  return doc.save();
}
