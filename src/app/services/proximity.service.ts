import { Injectable, signal } from '@angular/core';
import { ArGeoPoint } from '../lib/ar/ar.models';

/**
 * Shared geolocation watch (FASE 1.5, grows into the FASE 3 proximity layer).
 *
 * ONE watchPosition for the whole app (project rule), reference-counted:
 * every consumer calls start() on init and stop() on destroy; the underlying
 * watch lives while at least one consumer remains. Consumers read the
 * `userPos` signal and compute distances with haversine (no Google Maps
 * geometry dependency, so the AR scene can use it before/without Maps).
 */
@Injectable({ providedIn: 'root' })
export class ProximityService {
  readonly userPos = signal<ArGeoPoint | null>(null);
  readonly accuracy = signal<number | null>(null);
  readonly error = signal('');

  private watchId = -1;
  private refs = 0;

  start(): void {
    this.refs++;
    if (this.watchId >= 0 || !navigator.geolocation) return;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.userPos.set({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        this.accuracy.set(pos.coords.accuracy ?? null);
        this.error.set('');
      },
      (err) => this.error.set(err?.message ?? 'geolocation error'),
      { enableHighAccuracy: true, maximumAge: 3000 },
    );
  }

  stop(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0 && this.watchId >= 0) {
      navigator.geolocation?.clearWatch(this.watchId);
      this.watchId = -1;
    }
  }

  /** Distance in meters from the current fix to a point (null = no fix yet). */
  distanceTo(p: ArGeoPoint): number | null {
    const u = this.userPos();
    return u ? ProximityService.haversineMeters(u, p) : null;
  }

  static haversineMeters(a: ArGeoPoint, b: ArGeoPoint): number {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
}
