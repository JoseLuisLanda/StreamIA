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
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GoogleMapsLoaderService } from '../../../services/google-maps-loader.service';
import { ArElement } from '../../../lib/ar/ar.models';

/**
 * RIGHT panel: Google Map on the right THIRD of the screen, transparent/glass
 * container. FASE 1 scope: user blue dot (own geolocation watch) + pins of the
 * published GPS elements; tap a pin -> (elementFocus) so the page can surface
 * its media. FASE 3 replaces the local watch with the shared ProximityService
 * and adds threshold highlighting + "Llevame".
 *
 * The map instance is created ONCE and survives panel switches (the shell only
 * translates the panel); it is destroyed with the route.
 */
@Component({
  selector: 'app-ar-map-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="glass">
      <div #mapHost class="map"></div>
      <p class="err" *ngIf="loader.error()">{{ loader.error() }}</p>
    </div>
  `,
  styles: [`
    /* pointer-events AUTO: the shell's ".panel > *" rule cannot style projected
       content (view encapsulation) -- see ar-media-panel note. */
    :host { display: block; position: absolute; right: 0; top: 0; bottom: 0; width: min(34vw, 360px); min-width: 250px; pointer-events: auto; }
    .glass { position: absolute; inset: 10px 8px calc(env(safe-area-inset-bottom) + 70px) 8px;
      background: rgba(10,14,20,.45); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.14);
      border-radius: 16px; padding: 46px 8px 8px; display: flex; flex-direction: column; }
    .map { flex: 1; min-height: 0; border-radius: 12px; overflow: hidden; opacity: .92; }
    .err { color: #ffb3a6; font-size: 11.5px; margin: 6px 2px 0; }
  `],
})
export class ArMapPanelComponent implements AfterViewInit, OnChanges, OnDestroy {
  /** Published GPS elements to pin. */
  @Input() elements: ArElement[] = [];
  @Output() elementFocus = new EventEmitter<string>();

  @ViewChild('mapHost') mapHost!: ElementRef<HTMLDivElement>;
  readonly loader = inject(GoogleMapsLoaderService);

  private map: any = null;
  private userMarker: any = null;
  private pins: any[] = [];
  private watchId = -1;
  private destroyed = false;

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
      zoomControl: true,
    };
    if (this.loader.mapId) opts.mapId = this.loader.mapId;
    this.map = new g.Map(this.mapHost.nativeElement, opts);
    this.renderPins();
    this.watchUser();
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (ch['elements'] && this.map) this.renderPins();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.watchId >= 0) navigator.geolocation?.clearWatch(this.watchId);
    this.pins = [];
    this.map = null;
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

  /** Own lightweight geolocation watch (FASE 3 swaps in ProximityService). */
  private watchUser(): void {
    if (!navigator.geolocation) return;
    const g = this.loader.maps;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!this.map) return;
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
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
      },
      () => { /* denied/unavailable -> map still useful with pins */ },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
  }
}
