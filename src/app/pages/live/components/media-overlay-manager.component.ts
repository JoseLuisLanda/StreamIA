import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MediaOverlay } from '../../../components/media-overlay/media-overlay.component';
import { ImageCollection } from '../live.models';

@Component({
  selector: 'app-media-overlay-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="overlay-manager-content">
      <div class="action-bar">
        <div class="header-controls">
          <button 
            class="icon-btn" 
            [class.active]="isFreeMoveMode" 
            (click)="onToggleFreeMove.emit()"
            title="Toggle Free Move Mode"
          >
            ✋
          </button>
          <button class="add-overlay-btn" (click)="onAddOverlay.emit()">+ Add</button>
        </div>
      </div>
      
      <!-- Size and Layout Controls (only shown when an overlay is selected) -->
      <div class="overlay-settings" *ngIf="selectedOverlay">
        <div class="selected-overlay-label">
          Editing: <strong>{{ selectedOverlay.name }}</strong>
        </div>
        
        <div class="setting-row">
          <label>Layout:</label>
          <select [(ngModel)]="selectedOverlay.layout" (ngModelChange)="onLayoutChangeHandler($event)">
            <option value="horizontal">Horizontal (4:3)</option>
            <option value="square">Square (1:1)</option>
            <option value="vertical">Vertical (3:4)</option>
          </select>
        </div>
        
        <div class="setting-row">
          <label>Size:</label>
          <input 
            type="range" 
            [ngModel]="selectedOverlay.width" 
            (ngModelChange)="onSizeChange($event)" 
            min="150" 
            max="800" 
            step="10"
          >
          <span class="size-display">{{ selectedOverlay.width }}x{{ selectedOverlay.height }}</span>
        </div>
      </div>

      <div class="overlays-list" *ngIf="mediaOverlays.length > 0">
        <div 
          class="item-card" 
          *ngFor="let overlay of mediaOverlays"
          [class.selected]="overlay.id === selectedOverlayId"
          (click)="onSelectOverlay.emit(overlay.id)"
        >
          <div class="item-header">
            <span class="item-name">{{ overlay.name }}</span>
            <button class="item-remove" (click)="onRemoveOverlay.emit(overlay.id); $event.stopPropagation()">🗑️</button>
          </div>
          
          <div class="item-controls">
            <button class="share-screen-btn" (click)="onCaptureScreen.emit(overlay); $event.stopPropagation()">
              🖥️ Share Window/Screen
            </button>
            
            <select 
              [ngModel]="''" 
              (ngModelChange)="onAssignCollection.emit({overlay, collectionId: $event}); $event.stopPropagation()"
              (click)="$event.stopPropagation()"
              class="collection-select"
              *ngIf="collections.length > 0"
            >
              <option value="" disabled selected>Or select collection...</option>
              <option *ngFor="let col of collections" [value]="col.id">{{ col.name }}</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .action-bar {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 1rem;
    }
    .header-controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .add-overlay-btn {
      padding: 6px 14px;
      border-radius: 8px;
      border: 1px solid rgba(0, 217, 255, 0.3);
      background: rgba(0, 217, 255, 0.1);
      color: #00d9ff;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .add-overlay-btn:hover {
      background: #00d9ff;
      color: #000;
      transform: translateY(-1px);
    }
    .overlay-settings {
      margin-bottom: 1.25rem;
      padding: 1rem;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .selected-overlay-label {
      color: #00d9ff;
      font-size: 0.85rem;
      margin-bottom: 0.75rem;
      padding: 0.5rem;
      background: rgba(0, 217, 255, 0.1);
      border-radius: 6px;
      border: 1px solid rgba(0, 217, 255, 0.2);
    }
    .selected-overlay-label strong {
      color: #fff;
    }
    .setting-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }
    .setting-row:last-child {
      margin-bottom: 0;
    }
    .setting-row label {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.8rem;
      min-width: 60px;
    }
    .setting-row select {
      flex: 1;
      padding: 0.4rem 0.6rem;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      color: #fff;
      font-size: 0.8rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .setting-row select:hover {
      background: rgba(0, 0, 0, 0.6);
      border-color: rgba(0, 217, 255, 0.4);
    }
    .setting-row select:focus {
      outline: none;
      border-color: #00d9ff;
      box-shadow: 0 0 8px rgba(0, 217, 255, 0.3);
    }
    .setting-row select option {
      background: #1a1a1a;
      color: #fff;
      padding: 0.5rem;
    }
    .setting-row input[type="range"] {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.1);
      outline: none;
      -webkit-appearance: none;
    }
    .setting-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #00d9ff;
      cursor: pointer;
      transition: all 0.2s;
    }
    .setting-row input[type="range"]::-webkit-slider-thumb:hover {
      transform: scale(1.2);
      box-shadow: 0 0 10px rgba(0, 217, 255, 0.5);
    }
    .size-display {
      color: rgba(255, 255, 255, 0.6);
      font-size: 0.75rem;
      min-width: 80px;
      text-align: right;
    }
    .item-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 1rem;
      margin-bottom: 0.75rem;
      transition: all 0.2s;
      cursor: pointer;
    }
    .item-card:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(0, 217, 255, 0.2);
    }
    .item-card.selected {
      background: rgba(0, 217, 255, 0.1);
      border-color: rgba(0, 217, 255, 0.4);
      box-shadow: 0 0 15px rgba(0, 217, 255, 0.2);
    }
    .item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }
    .item-name {
      color: #fff;
      font-size: 0.9rem;
      font-weight: 600;
    }
    .item-remove {
      background: transparent;
      border: none;
      cursor: pointer;
      color: rgba(255, 255, 255, 0.3);
      font-size: 1.1rem;
      transition: color 0.2s;
    }
    .item-remove:hover {
      color: #ff4444;
    }
    .share-screen-btn {
      width: 100%;
      padding: 10px;
      background: rgba(0, 217, 255, 0.1);
      border: 1px solid rgba(0, 217, 255, 0.2);
      color: #00d9ff;
      border-radius: 8px;
      cursor: pointer;
      margin-bottom: 0.75rem;
      font-weight: 600;
      font-size: 0.85rem;
      transition: all 0.2s;
    }
    .share-screen-btn:hover {
      background: rgba(0, 217, 255, 0.2);
      transform: translateY(-1px);
    }
    .collection-select {
      width: 100%;
      padding: 10px;
      background: rgba(0, 0, 0, 0.4);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      font-size: 0.85rem;
      outline: none;
      cursor: pointer;
      transition: all 0.2s;
    }
    .collection-select:hover {
      background: rgba(0, 0, 0, 0.6);
      border-color: rgba(0, 217, 255, 0.4);
    }
    .collection-select:focus {
      border-color: #00d9ff;
      box-shadow: 0 0 8px rgba(0, 217, 255, 0.3);
    }
    .collection-select option {
      background: #1a1a1a;
      color: #fff;
      padding: 0.5rem;
    }
    .icon-btn {
      width: 32px;
      height: 32px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #fff;
      cursor: pointer;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .icon-btn.active {
      color: #000;
      background: #00d9ff;
      border-color: transparent;
      box-shadow: 0 0 10px rgba(0, 217, 255, 0.3);
    }
  `]
})
export class MediaOverlayManagerComponent {
  @Input() mediaOverlays: MediaOverlay[] = [];
  @Input() isFreeMoveMode = false;
  @Input() selectedOverlayId: string | null = null;
  @Input() collections: ImageCollection[] = [];

  @Output() onToggleFreeMove = new EventEmitter<void>();
  @Output() onAddOverlay = new EventEmitter<void>();
  @Output() onRemoveOverlay = new EventEmitter<string>();
  @Output() onCaptureScreen = new EventEmitter<MediaOverlay>();
  @Output() onAssignCollection = new EventEmitter<{ overlay: MediaOverlay, collectionId: string }>();
  @Output() onSelectOverlay = new EventEmitter<string>();
  @Output() onResizeOverlay = new EventEmitter<{ overlayId: string, size: number }>();
  @Output() onLayoutChange = new EventEmitter<{ overlayId: string, layout: 'horizontal' | 'vertical' | 'square' }>();

  get selectedOverlay(): MediaOverlay | null {
    if (!this.selectedOverlayId) return null;
    return this.mediaOverlays.find(o => o.id === this.selectedOverlayId) || null;
  }

  onSizeChange(size: number) {
    if (this.selectedOverlayId) {
      this.onResizeOverlay.emit({ overlayId: this.selectedOverlayId, size });
    }
  }

  onLayoutChangeHandler(layout: 'horizontal' | 'vertical' | 'square') {
    if (this.selectedOverlayId) {
      this.onLayoutChange.emit({ overlayId: this.selectedOverlayId, layout });
    }
  }
}
