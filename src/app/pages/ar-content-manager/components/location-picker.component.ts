import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GoogleMapsLoaderService } from '../../../services/google-maps-loader.service';
import { ArGeoPoint } from '../../../lib/ar/ar.models';

/**
 * GPS location picker for AR elements (FASE 0, seccion 4.4):
 * Google Map with a DRAGGABLE pin kept in two-way sync with numeric lat/lng
 * inputs, plus a "use my current location" button. Emits (geoChange) on every
 * pin drag / input edit / geolocation fix; the parent editor persists it.
 *
 * Uses AdvancedMarkerElement when environment.googleMapsMapId is set (required
 * by Advanced Markers); falls back to the classic google.maps.Marker otherwise
 * so the picker still works before a Map ID is provisioned.
 */
@Component({
  selector: 'app-ar-location-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="lp">
      <div class="row">
        <label class="fld"><span>Latitud</span>
          <input type="number" step="0.000001" [ngModel]="lat" (ngModelChange)="onInputChange($event, lng)" />
        </label>
        <label class="fld"><span>Longitud</span>
          <input type="number" step="0.000001" [ngModel]="lng" (ngModelChange)="onInputChange(lat, $event)" />
        </label>
        <button class="btn ghost sm" type="button" (click)="useMyLocation()" [disabled]="locating">
          {{ locating ? 'Ubicando...' : 'Usar mi ubicacion actual' }}
        </button>
      </div>
      <div #mapHost class="map"></div>
      <p class="hint" *ngIf="loader.error()">{{ loader.error() }}</p>
      <p class="hint" *ngIf="geoErr">{{ geoErr }}</p>
    </div>
  `,
  styles: [`
    .lp { display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
    .fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #99a; }
    .fld input { width: 140px; background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 7px 9px; font-size: 13px; }
    .map { height: 260px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); overflow: hidden; background: #0d1119; }
    .hint { font-size: 11px; color: #f0c674; margin: 0; }
    .btn { padding: 8px 13px; border-radius: 9px; cursor: pointer; font-size: 12.5px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); color: #cdd; }
    .btn:hover:not(:disabled) { background: rgba(255,255,255,.12); }
    .btn:disabled { opacity: .5; cursor: default; }
  `],
})
export class ArLocationPickerComponent implements AfterViewInit, OnDestroy {
  /** Initial coordinates (0/0 or undefined = unset -> default center). */
  @Input() lat = 0;
  @Input() lng = 0;
  @Output() geoChange = new EventEmitter<ArGeoPoint>();

  @ViewChild('mapHost') mapHost!: ElementRef<HTMLDivElement>;

  readonly loader = inject(GoogleMapsLoaderService);

  locating = false;
  geoErr = '';

  private map: any = null;
  private marker: any = null;
  private usesAdvanced = false;
  private destroyed = false;

  /** Default map center when the element has no position yet (CDMX). */
  private static readonly DEFAULT_CENTER: ArGeoPoint = { lat: 19.432608, lng: -99.133209 };

  async ngAfterViewInit(): Promise<void> {
    try {
      await this.loader.load();
    } catch {
      return; // loader.error() is shown in the template
    }
    if (this.destroyed) return;
    this.buildMap();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    // Let GC reclaim the map; the container is removed with the component.
    this.map = null;
    this.marker = null;
  }

  private hasValue(): boolean {
    return Number.isFinite(this.lat) && Number.isFinite(this.lng) && !(this.lat === 0 && this.lng === 0);
  }

  private center(): ArGeoPoint {
    return this.hasValue() ? { lat: this.lat, lng: this.lng } : ArLocationPickerComponent.DEFAULT_CENTER;
  }

  private buildMap(): void {
    const g = this.loader.maps;
    if (!g || !this.mapHost) return;
    const mapId = this.loader.mapId;
    const opts: any = {
      center: this.center(),
      zoom: this.hasValue() ? 17 : 12,
      gestureHandling: 'greedy',
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
    };
    if (mapId) opts.mapId = mapId;
    this.map = new g.Map(this.mapHost.nativeElement, opts);

    this.usesAdvanced = !!(mapId && g.marker?.AdvancedMarkerElement);
    if (this.usesAdvanced) {
      this.marker = new g.marker.AdvancedMarkerElement({
        map: this.map,
        position: this.center(),
        gmpDraggable: true,
      });
      this.marker.addListener('dragend', () => {
        const p = this.marker.position;
        if (!p) return;
        const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
        const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
        this.setValue(lat, lng, false);
      });
    } else {
      this.marker = new g.Marker({ map: this.map, position: this.center(), draggable: true });
      this.marker.addListener('dragend', (ev: any) => {
        this.setValue(ev.latLng.lat(), ev.latLng.lng(), false);
      });
    }
    // Click-to-place is a natural complement to dragging.
    this.map.addListener('click', (ev: any) => {
      if (ev?.latLng) this.setValue(ev.latLng.lat(), ev.latLng.lng(), false);
    });
  }

  onInputChange(lat: number | null, lng: number | null): void {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    this.setValue(la, ln, true);
  }

  /**
   * "Usar mi ubicacion": instead of taking the FIRST fix (which on desktop is
   * WiFi/IP-based and often off by tens/hundreds of meters), watch the signal
   * for up to WATCH_MS and keep the most ACCURATE fix seen, updating the pin
   * live as it refines. Stops early when accuracy is <= GOOD_ACCURACY_M.
   * The pin remains draggable for the final manual adjustment.
   */
  useMyLocation(): void {
    this.geoErr = '';
    if (!navigator.geolocation) {
      this.geoErr = 'Geolocalizacion no disponible en este navegador.';
      return;
    }
    const WATCH_MS = 8000;
    const GOOD_ACCURACY_M = 15;
    this.locating = true;
    let best: GeolocationPosition | null = null;
    let watchId = -1;
    let timer: any = null;

    const finish = () => {
      if (watchId >= 0) navigator.geolocation.clearWatch(watchId);
      if (timer) clearTimeout(timer);
      this.locating = false;
      if (best) {
        const acc = Math.round(best.coords.accuracy || 0);
        this.geoErr = acc
          ? `Precision aproximada: ${acc} m. Ajusta el pin arrastrandolo si hace falta.`
          : '';
      } else if (!this.geoErr) {
        this.geoErr = 'No se pudo obtener la ubicacion.';
      }
    };

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!best || pos.coords.accuracy < best.coords.accuracy) {
          best = pos;
          // Update the pin live so the user sees the fix refining.
          this.setValue(pos.coords.latitude, pos.coords.longitude, true);
        }
        if (pos.coords.accuracy <= GOOD_ACCURACY_M) finish();
      },
      (err) => {
        this.geoErr = 'No se pudo obtener la ubicacion: ' + (err?.message ?? 'error');
        finish();
      },
      { enableHighAccuracy: true, timeout: WATCH_MS, maximumAge: 0 },
    );
    timer = setTimeout(finish, WATCH_MS);
  }

  /** Update inputs + pin + parent. moveMap recenters when the change came from
   *  outside the map (inputs / geolocation). */
  private setValue(lat: number, lng: number, moveMap: boolean): void {
    this.lat = Math.round(lat * 1e6) / 1e6;
    this.lng = Math.round(lng * 1e6) / 1e6;
    const pos = { lat: this.lat, lng: this.lng };
    if (this.marker) {
      if (this.usesAdvanced) this.marker.position = pos;
      else this.marker.setPosition(pos);
    }
    if (moveMap && this.map) {
      this.map.setCenter(pos);
      if (this.map.getZoom() < 15) this.map.setZoom(17);
    }
    this.geoChange.emit(pos);
  }
}
