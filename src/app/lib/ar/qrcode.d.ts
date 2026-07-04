/**
 * OBSOLETE (harmless): the QR is now generated SERVER-SIDE by the
 * generateMarkerKit callable (functions/src/markerKit.ts); the frontend no
 * longer imports `qrcode`. This ambient declaration remains only because the
 * sandbox cannot delete files -- feel free to remove it.
 */
declare module 'qrcode';
