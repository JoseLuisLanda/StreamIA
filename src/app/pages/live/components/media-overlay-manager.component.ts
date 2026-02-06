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
        <button 
          class="icon-toggle-btn" 
          [class.active]="isFreeMoveMode" 
          (click)="onToggleFreeMove.emit()"
          title="Toggle Free Move Mode"
        >
          <span class="btn-icon">✋</span> Free Move
        </button>
        <button class="primary-btn" (click)="onAddOverlay.emit()">+ Add Screen</button>
      </div>
      
      <!-- Settings Panel -->
      <div class="settings-panel" *ngIf="selectedOverlay">
        <div class="panel-header">
           <span class="panel-label">Selected:</span>
           <span class="selected-name">{{ selectedOverlay.name }}</span>
        </div>
        
        <div class="control-row">
          <label>Layout</label>
          <div class="segmented-control">
             <button class="segment-btn" [class.active]="selectedOverlay.layout === 'horizontal'" (click)="onLayoutChangeHandler('horizontal')">4:3</button>
             <button class="segment-btn" [class.active]="selectedOverlay.layout === 'square'" (click)="onLayoutChangeHandler('square')">1:1</button>
             <button class="segment-btn" [class.active]="selectedOverlay.layout === 'vertical'" (click)="onLayoutChangeHandler('vertical')">3:4</button>
          </div>
        </div>
        
        <div class="control-row">
          <div class="label-row">
            <label>Size</label>
            <span class="value-display">{{ selectedOverlay.width }}px</span>
          </div>
          <input 
            type="range" 
            [ngModel]="selectedOverlay.width" 
            (ngModelChange)="onSizeChange($event)" 
            min="150" 
            max="800" 
            step="10"
            class="range-slider"
          >
        </div>
      </div>

      <div class="overlays-list" *ngIf="mediaOverlays.length > 0">
        <div 
          class="list-item" 
          *ngFor="let overlay of mediaOverlays"
          [class.selected]="overlay.id === selectedOverlayId"
          (click)="onSelectOverlay.emit(overlay.id)"
        >
          <div class="item-main">
            <span class="item-icon">📺</span>
            <div class="item-details">
                <span class="item-name">{{ overlay.name }}</span>
                <span class="item-sub">{{ overlay.width }}x{{ overlay.height }}</span>
            </div>
          </div>
          
          <div class="item-actions">
             <button class="action-icon-btn delete" (click)="onRemoveOverlay.emit(overlay.id); $event.stopPropagation()">🗑️</button>
          </div>
          
          <div class="item-tools" *ngIf="overlay.id === selectedOverlayId" (click)="$event.stopPropagation()">
            <button class="tool-btn" (click)="onCaptureScreen.emit(overlay)">
               🖥️ Share Screen
            </button>
            <select 
              [ngModel]="''" 
              (ngModelChange)="onAssignCollection.emit({overlay, collectionId: $event})"
              class="tool-select"
              *ngIf="collections.length > 0"
            >
              <option value="" disabled selected>Assign Collection...</option>
              <option *ngFor="let col of collections" [value]="col.id">{{ col.name }}</option>
            </select>
          </div>
        </div>
      </div>
      
      <div class="empty-state" *ngIf="mediaOverlays.length === 0">
         No screens added yet.
      </div>
    </div>
  `,
  styles: [`
    .action-bar {
        display: flex;
        justify-content: space-between;
        margin-bottom: 1rem;
        gap: 0.5rem;
    }
    .primary-btn {
        background: linear-gradient(135deg, #FF3BFF, #5C24FF);
        color: white;
        border: none;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.2s;
    }
    .primary-btn:hover {
        opacity: 0.9;
    }
    .icon-toggle-btn {
        background: #0B0F19;
        border: 1px solid #23293D;
        color: #94A3B8;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 0.8rem;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .icon-toggle-btn.active {
        background: #23293D;
        color: #fff;
        border-color: #5C24FF;
    }
    
    /* Settings Panel */
    .settings-panel {
        background: #0B0F19;
        border: 1px solid #23293D;
        border-radius: 8px;
        padding: 0.75rem;
        margin-bottom: 1rem;
    }
    .panel-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 0.75rem;
        border-bottom: 1px solid #1F2436;
        padding-bottom: 0.5rem;
    }
    .panel-label {
        color: #64748B;
        font-size: 0.75rem;
        text-transform: uppercase;
        font-weight: 600;
    }
    .selected-name {
        color: #fff;
        font-weight: 600;
        font-size: 0.85rem;
    }
    
    .control-row {
        margin-bottom: 0.75rem;
    }
    .control-row label {
        display: block;
        color: #94A3B8;
        font-size: 0.75rem;
        font-weight: 600;
        margin-bottom: 0.4rem;
        text-transform: uppercase;
    }
    
    /* Segmented Control */
    .segmented-control {
      display: flex;
      background: #151926;
      padding: 3px;
      border-radius: 6px;
      border: 1px solid #23293D;
    }
    .segment-btn {
      flex: 1;
      padding: 6px;
      border: none;
      background: transparent;
      color: #94A3B8;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 600;
      transition: all 0.2s;
    }
    .segment-btn.active {
      background: #23293D;
      color: #fff;
    }
    
    /* Range Slider */
    .label-row {
        display: flex;
        justify-content: space-between;
        margin-bottom: 0.4rem;
    }
    .value-display {
        color: #5C24FF;
        font-size: 0.75rem;
        font-weight: 600;
    }
    .range-slider {
        width: 100%;
        height: 4px;
        border-radius: 2px;
        background: #23293D;
        outline: none;
        -webkit-appearance: none;
        accent-color: #5C24FF;
    }
    
    /* List Items */
    .list-item {
        background: #151926;
        border: 1px solid #23293D;
        border-radius: 8px;
        margin-bottom: 0.5rem;
        overflow: hidden;
        transition: all 0.2s;
        cursor: pointer;
    }
    .list-item:hover {
        border-color: #3B4259;
    }
    .list-item.selected {
        border-color: #5C24FF;
        background: #1A1E2E;
    }
    .item-main {
        padding: 10px;
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .item-icon {
        font-size: 1.2rem;
    }
    .item-details {
        display: flex;
        flex-direction: column;
    }
    .item-name {
        color: #E2E8F0;
        font-size: 0.85rem;
        font-weight: 600;
    }
    .item-sub {
        color: #64748B;
        font-size: 0.75rem;
    }
    .item-actions {
        margin-left: auto;
        padding-right: 10px;
    }
    .list-item .item-main {
        position: relative;
    }
    .list-item .item-actions {
        position: absolute; 
        right: 10px; 
        top: 10px;
    }
    
    .action-icon-btn {
        background: transparent;
        border: none;
        cursor: pointer;
        opacity: 0.5;
        transition: opacity 0.2s;
        font-size: 1rem;
    }
    .action-icon-btn:hover {
        opacity: 1;
    }
    
    /* Item Tools (Expanded) */
    .item-tools {
        padding: 10px;
        background: #0B0F19;
        border-top: 1px solid #23293D;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .tool-btn {
        width: 100%;
        padding: 8px;
        background: #23293D;
        color: #E2E8F0;
        border: 1px solid #3B4259;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.8rem;
        transition: all 0.2s;
    }
    .tool-btn:hover {
        background: #2A3042;
        color: #fff;
    }
    .tool-select {
        width: 100%;
        padding: 8px;
        background: #0B0F19;
        color: #fff;
        border: 1px solid #23293D;
        border-radius: 6px;
        font-size: 0.8rem;
    }
    
    .empty-state {
        text-align: center;
        color: #64748B;
        font-size: 0.85rem;
        padding: 1rem;
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
