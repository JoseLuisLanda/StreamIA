import { Injectable, signal } from '@angular/core';
import { environment } from '../../environments/environment';

/**
 * Idempotent dynamic loader for the Google Maps JavaScript API.
 *
 * - Loads the script ONCE per session, and ONLY when a route actually calls
 *   load() (the AR content manager's location picker now; the FASE 3 mini-map
 *   later). No global <script> tag; nothing loads on unrelated routes.
 * - Key: environment.googleMapsApiKey -- the ONLY key allowed in the client,
 *   and it MUST be referrer-restricted in Google Cloud Console (see
 *   docs/AR_CONTENT_MANAGER_README.md). All other keys stay in Secret Manager.
 * - Libraries maps/marker/geometry are requested up-front; use importLibrary()
 *   for typed-ish access after readiness.
 * - Deliberately typed loosely (any) so the app compiles with or without
 *   @types/google.maps installed (recommended for DX, not required).
 * - No COOP/COEP headers are involved -- the Piper worker constraint is safe.
 */
@Injectable({ providedIn: 'root' })
export class GoogleMapsLoaderService {
  /** True once google.maps is usable. */
  readonly mapsReady = signal(false);
  readonly error = signal<string>('');

  private loadPromise: Promise<void> | null = null;

  /** The google.maps namespace (null before load). */
  get maps(): any {
    return (window as any).google?.maps ?? null;
  }

  get mapId(): string {
    return (environment as any).googleMapsMapId ?? '';
  }

  /** Load the Maps JS API once. Safe to call from multiple components. */
  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    if (this.maps) {
      this.mapsReady.set(true);
      this.loadPromise = Promise.resolve();
      return this.loadPromise;
    }
    const key = ((environment as any).googleMapsApiKey ?? '').trim();
    if (!key) {
      const msg = 'Falta googleMapsApiKey en environments/ (restringida por referrer).';
      this.error.set(msg);
      return Promise.reject(new Error(msg));
    }
    this.loadPromise = new Promise<void>((resolve, reject) => {
      const cbName = '__gmapsLoaded_' + Math.random().toString(36).slice(2);
      (window as any)[cbName] = () => {
        delete (window as any)[cbName];
        this.mapsReady.set(true);
        resolve();
      };
      const s = document.createElement('script');
      const params = new URLSearchParams({
        key,
        v: 'weekly',
        libraries: 'maps,marker,geometry',
        loading: 'async',
        callback: cbName,
      });
      s.src = 'https://maps.googleapis.com/maps/api/js?' + params.toString();
      s.async = true;
      s.onerror = () => {
        delete (window as any)[cbName];
        this.loadPromise = null;
        const msg = 'No se pudo cargar Google Maps JS (revisa la clave y el referrer).';
        this.error.set(msg);
        reject(new Error(msg));
      };
      document.head.appendChild(s);
    });
    return this.loadPromise;
  }

  /** google.maps.importLibrary wrapper (after load()). */
  async importLibrary(name: 'maps' | 'marker' | 'geometry' | string): Promise<any> {
    await this.load();
    return (window as any).google.maps.importLibrary(name);
  }
}
