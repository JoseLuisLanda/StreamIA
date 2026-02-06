import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ImageCollection } from '../live.models';

@Component({
  selector: 'app-background-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="background-manager-content">
      <div class="new-collection">
        <input 
          type="text" 
          [(ngModel)]="collectionName" 
          placeholder="New Collection Name"
          class="custom-input"
        />
        <input 
          type="file" 
          #fileInput 
          (change)="handleFiles($event)" 
          accept="image/*,video/*" 
          multiple 
          style="display: none"
        />
        <button 
          class="primary-btn" 
          [disabled]="!collectionName.trim()"
          (click)="fileInput.click()"
        >
          Add
        </button>
      </div>
      
      <div class="collections-list" *ngIf="collections.length > 0">
        <div 
          *ngFor="let collection of collections" 
          class="collection-item"
          [class.active]="activeCollection?.id === collection.id"
        >
          <div class="collection-header" (click)="onSelect.emit(collection)">
            <div class="collection-preview">
              <img *ngIf="collection.images[0] && !isVideo(collection.images[0])" [src]="collection.images[0]" alt="Preview" />
              <video *ngIf="collection.images[0] && isVideo(collection.images[0])" [src]="collection.images[0]" muted playsinline style="width:100%; height:100%; object-fit:cover"></video>
            </div>
            <div class="collection-info">
              <span class="collection-name">{{ collection.name }}</span>
              <span class="collection-count">{{ collection.images.length }} assets</span>
            </div>
            <button class="delete-icon" (click)="deleteCollection(collection, $event)">×</button>
          </div>
        </div>
      </div>
      
      <!-- Carousel Controls -->
      <div class="controls-card" *ngIf="activeCollection && activeCollection.images.length > 1">
        <div class="card-title">Playback Controls</div>
        
        <div class="carousel-nav">
          <button class="nav-btn" (click)="onPrev.emit()">←</button>
          <span class="nav-display">{{ currentIndex + 1 }} / {{ activeCollection.images.length }}</span>
          <button class="nav-btn" (click)="onNext.emit()">→</button>
        </div>

        <div class="divider"></div>
        
        <div class="mode-toggle">
          <label class="radio-label">
            <input type="radio" name="carouselMode" value="manual" [ngModel]="mode" (ngModelChange)="onModeChange.emit($event)" />
            <span>Manual</span>
          </label>
          <label class="radio-label">
            <input type="radio" name="carouselMode" value="auto" [ngModel]="mode" (ngModelChange)="onModeChange.emit($event)" />
            <span>Auto Loop</span>
          </label>
        </div>
        
        <div class="auto-settings" *ngIf="mode === 'auto'">
          <label>Interval (s)</label>
          <div class="input-row">
            <input 
                type="number" 
                [ngModel]="interval" 
                (ngModelChange)="onIntervalChange.emit($event)"
                min="1" 
                max="60"
                class="small-input"
            />
            <span class="status-badge">Running</span>
          </div>
        </div>
      </div>
      
      <button class="block-btn danger" *ngIf="activeCollection" (click)="onClear.emit()">
        Remove Active Background
      </button>
      
      <div class="empty-state" *ngIf="collections.length === 0">
         Create a collection to start.
      </div>
    </div>
  `,
  styles: [`
    .new-collection {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .custom-input {
      flex: 1;
      padding: 10px;
      border-radius: 6px;
      background: #0B0F19;
      color: #fff;
      border: 1px solid #23293D;
      font-size: 0.85rem;
      outline: none;
    }
    .custom-input:focus {
        border-color: #5C24FF;
    }
    .primary-btn {
        background: linear-gradient(135deg, #FF3BFF, #5C24FF);
        color: white;
        border: none;
        padding: 0 16px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 0.8rem;
    }
    .primary-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        background: #23293D;
        color: #64748B;
    }
    
    .collections-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 250px;
      overflow-y: auto;
      margin-bottom: 1rem;
    }
    .collection-item {
      background: #151926;
      border: 1px solid #23293D;
      border-radius: 8px;
      transition: all 0.2s;
    }
    .collection-item:hover {
      border-color: #3B4259;
    }
    .collection-item.active {
      border-color: #5C24FF;
      background: #1A1E2E;
    }
    
    .collection-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      cursor: pointer;
      position: relative;
    }
    .collection-preview {
      width: 40px;
      height: 40px;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid #23293D;
      background: #000;
    }
    .collection-preview img, .collection-preview video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .collection-info {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .collection-name {
      color: #E2E8F0;
      font-size: 0.85rem;
      font-weight: 500;
    }
    .collection-count {
      color: #64748B;
      font-size: 0.7rem;
    }
    .delete-icon {
        background: transparent;
        border: none;
        color: #64748B;
        cursor: pointer;
        padding: 4px;
        font-size: 1.2rem;
        line-height: 1;
        opacity: 0.5;
        transition: opacity 0.2s;
    }
    .delete-icon:hover {
        opacity: 1;
        color: #ef4444;
    }
    
    /* Controls Card */
    .controls-card {
        background: #0B0F19;
        border: 1px solid #23293D;
        border-radius: 8px;
        padding: 1rem;
        margin-bottom: 1rem;
    }
    .card-title {
        color: #64748B;
        font-size: 0.75rem;
        text-transform: uppercase;
        font-weight: 600;
        margin-bottom: 1rem;
    }
    
    .carousel-nav {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 1rem;
        margin-bottom: 1rem;
    }
    .nav-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: #23293D;
        color: #fff;
        border: 1px solid #3B4259;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .nav-btn:hover {
        background: #5C24FF;
        border-color: #5C24FF;
    }
    .nav-display {
        font-family: monospace;
        color: #E2E8F0;
    }
    
    .divider {
        height: 1px;
        background: #1F2436;
        margin-bottom: 1rem;
    }
    
    .mode-toggle {
        display: flex;
        gap: 1rem;
        margin-bottom: 1rem;
    }
    .radio-label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: #94A3B8;
        font-size: 0.8rem;
        cursor: pointer;
    }
    .radio-label input {
        accent-color: #5C24FF;
    }
    
    .input-row {
        display: flex;
        align-items: center;
        gap: 1rem;
    }
    .small-input {
        width: 60px;
        padding: 6px;
        background: #151926;
        border: 1px solid #23293D;
        color: #fff;
        border-radius: 4px;
        text-align: center;
    }
    .status-badge {
        font-size: 0.7rem;
        color: #10B981;
        background: rgba(16, 185, 129, 0.1);
        padding: 2px 6px;
        border-radius: 4px;
    }
    .auto-settings label {
        display: block;
        font-size: 0.75rem;
        color: #64748B;
        margin-bottom: 4px;
    }
    
    .block-btn {
        width: 100%;
        padding: 10px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 0.8rem;
        font-weight: 500;
        transition: opacity 0.2s;
    }
    .block-btn.danger {
        background: rgba(239, 68, 68, 0.1);
        color: #ef4444;
        border: 1px solid rgba(239, 68, 68, 0.2);
    }
    .block-btn.danger:hover {
        background: rgba(239, 68, 68, 0.2);
    }
    
    .empty-state {
        text-align: center;
        color: #64748B;
        font-size: 0.8rem;
        padding: 1rem;
    }
  `]
})
export class BackgroundManagerComponent {
  @Input() collections: ImageCollection[] = [];
  @Input() activeCollection: ImageCollection | null = null;
  @Input() currentIndex = 0;
  @Input() mode: 'manual' | 'auto' = 'auto';
  @Input() interval = 5;

  @Output() onFilesSelected = new EventEmitter<{ event: Event, name: string }>();
  @Output() onSelect = new EventEmitter<ImageCollection>();
  @Output() onDelete = new EventEmitter<ImageCollection>();
  @Output() onPrev = new EventEmitter<void>();
  @Output() onNext = new EventEmitter<void>();
  @Output() onModeChange = new EventEmitter<'manual' | 'auto'>();
  @Output() onIntervalChange = new EventEmitter<number>();
  @Output() onClear = new EventEmitter<void>();

  collectionName = '';

  handleFiles(event: Event) {
    this.onFilesSelected.emit({ event, name: this.collectionName });
    this.collectionName = '';
  }

  deleteCollection(col: ImageCollection, event: Event) {
    event.stopPropagation();
    this.onDelete.emit(col);
  }

  isVideo(url: string | null): boolean {
    if (!url) return false;
    return url.startsWith('data:video') || url.endsWith('.mp4') || url.endsWith('.webm') || url.endsWith('.mov');
  }
}
