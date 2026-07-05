import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { effect } from '@angular/core';
import { GoogleMapsLoaderService } from '../../../services/google-maps-loader.service';
import { ProximityService } from '../../../services/proximity.service';
import { ArElement, ArGeoPoint } from '../../../lib/ar/ar.models';

/**
 * MINI-MAP (mockup layout v2): small rounded thumbnail anchored at the RIGHT
 * side (bottom-right, like the reference design). Clicking it expands the SAME
 * map into a centered POPUP (scrim + close); collapsing returns it to the
 * corner. ONE map instance for both states -- the container is restyled, never
 * recreated (Maps JS handles container resizes; we re-center afterwards).
 *
 * FASE 1 scope: user blue dot + pins of published GPS elements; pin tap emits
 * (elementFocus). FASE 3 adds proximity/threshold/"Llevame".
 */
@Component({
  selector: 'app-ar-map-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="scrim" *ngIf="expanded()" (click)="toggle(false)"></div>
    <div class="wrap" [class.big]="expanded()">
      <div #mapHost class="map"></div>
      <button class="cover" *ngIf="!expanded()" (click)="toggle(true)" title="Ampliar mapa"></button>
      <span class="minilabel" *ngIf="!expanded()">Mapa</span>
      <button class="close" *ngIf="expanded()" (click)="toggle(false)" title="Cerrar">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12 M18 6L6 18"/></svg>
      </button>
      <p class="err" *ngIf="loader.error()">{{ loader.error() }}</p>
    </div>
  `,
  styles: [`
    /* pointer-events AUTO: container rules cannot style projected content. */
    :host { display: block; position: absolute; right: 14px; bottom: calc(env(safe-area-inset-bottom) + 108px);
      pointer-events: auto; z-index: 7; }
    .scrim { position: fixed; inset: 0; z-index: 1150; background: rgba(0,0,0,.55); }
    .wrap { position: relative; width: 148px; height: 148px; border-radius: 16px; overflow: hidden;
      border: 1px solid rgba(255,255,255,.22); box-shadow: 0 6px 22px rgba(0,0,0,.45);
      background: rgba(10,14,20,.5); }
    .wrap.big { position: fixed; inset: max(6vh, 48px) 6vw; width: auto; height: auto; z-index: 1200;
      border-radius: 20px; }
    .map { position: absolute; inset: 0; }
    .cover { position: absolute; inset: 0; background: transparent; border: none; cursor: pointer; z-index: 2; }
    .minilabel { position: absolute; left: 8px; bottom: 6px; z-index: 3; font-size: 10px; letter-spacing: 1px;
      text-transform: uppercase; color: #fff; text-shadow: 0 1px 4px rgba(0,0,0,.8); pointer-events: none;
      font-family: 'Segoe UI', system-ui, sans-serif; }
    .close { position: absolute; top: 12px; right: 12px; z-index: 3; width: 36px; height: 36px;
      border-radius: 10px; display: grid; place-items: center; cursor: pointer;
      background: rgba(10,14,20,.7); border: 1px solid rgba(255,255,255,.25); color: #e6e8ee; }
    .err { position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 3; color: #ffb3a6;
      font-size: 10.5px; margin: 0; }
  `],
})
export class ArMapPanelComponent implements AfterViewInit, OnChanges, OnDestroy {
  /** Published GPS elements to pin. */
  @Input() elements: ArElement[] = [];
  @Output() elementFocus = new EventEmitter<string>();

  @ViewChild('mapHost') mapHost!: ElementRef<HTMLDivElement>;
  readonly loader = inject(GoogleMapsLoaderService);
  private prox = inject(ProximityService);
  readonly expanded = signal(false);

  private map: any = null;
  private userMarker: any = null;
  private pins: any[] = [];
  private destroyed = false;
  private lastCenter: { lat: number; lng: number } | null = null;

  constructor() {
    // SHARED geolocation (proximity.service): the map no longer runs its own
    // watchPosition (single-watch project rule).
    this.prox.start();
    effect(() => {
      const p = this.prox.userPos();
      if (p && this.map) this.updateUserMarker(p);
    });
  }

  async ngAfterViewInit(): Promise<void> {
    try {
      await this.loader.load();
    } catch {
      return;
    }
    if (this.destroyed) return;
    const g = this.loader.maps;
    const opts: any = {
      center: { lat: 19.432608, lng: -99.133209 },
      zoom: 16,
      gestureHandling: 'greedy',
      disableDefaultUI: true,
    };
    if (this.loader.mapId) opts.mapId = this.loader.mapId;
    this.map = new g.Map(this.mapHost.nativeElement, opts);
    this.renderPins();
    const p = this.prox.userPos();
    if (p) this.updateUserMarker(p);
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['elements'] && this.map) this.renderPins();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.prox.stop();
    this.pins = [];
    this.map = null;
  }

  /** Expand into the popup / collapse back to the corner. Same map instance;
   *  re-center after the container resize settles. */
  toggle(big: boolean): void {
    this.expanded.set(big);
    setTimeout(() => {
      if (!this.map) return;
      this.map.setZoom(big ? 17 : 16);
      if (this.lastCenter) this.map.setCenter(this.lastCenter);
    }, 120);
  }

  private renderPins(): void {
    const g = this.loader.maps;
    if (!g || !this.map) return;
    for (const p of this.pins) p.setMap ? p.setMap(null) : (p.map = null);
    this.pins = [];
    for (const el of this.elements) {
      if (!el.geo) continue;
      let pin: any;
      if (this.loader.mapId && g.marker?.AdvancedMarkerElement) {
        pin = new g.marker.AdvancedMarkerElement({ map: this.map, position: el.geo, title: el.name });
        pin.addListener('gmp-click', () => this.elementFocus.emit(el.id));
      } else {
        pin = new g.Marker({ map: this.map, position: el.geo, title: el.name });
        pin.addListener('click', () => this.elementFocus.emit(el.id));
      }
      this.pins.push(pin);
    }
  }

  /** Draw/refresh the user dot from the SHARED proximity fix. */
  private updateUserMarker(p: ArGeoPoint): void {
    const g = this.loader.maps;
    if (!g || !this.map) return;
    this.lastCenter = p;
    if (!this.userMarker) {
      const dot = document.createElement('div');
      dot.style.cssText =
        'width:14px;height:14px;border-radius:50%;background:#4285f4;border:2px solid #fff;box-shadow:0 0 8px rgba(66,133,244,.9)';
      if (this.loader.mapId && g.marker?.AdvancedMarkerElement) {
        this.userMarker = new g.marker.AdvancedMarkerElement({ map: this.map, position: p, content: dot });
      } else {
        this.userMarker = new g.Marker({
          map: this.map, position: p,
          icon: { path: g.SymbolPath.CIRCLE, scale: 7, fillColor: '#4285f4', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        });
      }
      this.map.setCenter(p);
    } else if (this.userMarker.setPosition) {
      this.userMarker.setPosition(p);
    } else {
      this.userMarker.position = p;
    }
  }
}
