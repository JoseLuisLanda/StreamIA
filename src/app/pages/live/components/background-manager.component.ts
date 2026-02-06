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
          placeholder="Collection name *"
          class="collection-name-input"
          [class.required]="!collectionName.trim()"
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
          class="upload-btn" 
          [class.disabled]="!collectionName.trim()"
          [disabled]="!collectionName.trim()"
          (click)="fileInput.click()"
        >
          + Add
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
              <span class="collection-count">{{ collection.images.length }} images</span>
            </div>
            <button class="delete-collection" (click)="deleteCollection(collection, $event)">🗑️</button>
          </div>
        </div>
      </div>
      
      <div class="no-collections" *ngIf="collections.length === 0">
        <p class="no-data-msg">No collections yet. Create one above!</p>
      </div>
      
      <div class="carousel-controls-panel" *ngIf="activeCollection && activeCollection.images.length > 1">
        <div class="carousel-nav">
          <button class="nav-btn" (click)="onPrev.emit()">◀</button>
          <span class="nav-indicator">{{ currentIndex + 1 }} / {{ activeCollection.images.length }}</span>
          <button class="nav-btn" (click)="onNext.emit()">▶</button>
        </div>
      </div>
      
      <div class="carousel-settings" *ngIf="activeCollection && activeCollection.images.length > 1">
        <div class="settings-header">
          <span>Carousel Settings</span>
        </div>
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
          <label>Interval:</label>
          <input 
            type="number" 
            [ngModel]="interval" 
            (ngModelChange)="onIntervalChange.emit($event)"
            min="1" 
            max="60"
            class="interval-input"
          />
          <span>sec</span>
          <span class="auto-status">
            <span class="pulse"></span> Running
          </span>
        </div>
      </div>
      
      <button class="clear-btn" *ngIf="activeCollection" (click)="onClear.emit()">
        Deselect Collection
      </button>
    </div>
  `,
  styles: [`
    .new-collection {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .collection-name-input {
      flex: 1;
      padding: 12px;
      background: rgba(0, 0, 0, 0.3);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 10px;
      font-size: 0.85rem;
      outline: none;
    }
    .collection-name-input::placeholder {
      color: rgba(255, 255, 255, 0.4);
    }
    .collection-name-input:focus {
      border-color: #00d9ff;
    }
    .upload-btn {
      padding: 10px 18px;
      background: linear-gradient(135deg, #00d9ff, #00ff88);
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 700;
      transition: all 0.2s;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-size: 0.8rem;
    }
    .upload-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 4px 12px rgba(0, 255, 136, 0.3);
    }
    .upload-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .collections-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-height: 200px;
      overflow-y: auto;
      padding-right: 5px;
    }
    .collections-list::-webkit-scrollbar {
      width: 4px;
    }
    .collections-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 10px;
    }
    .collection-item {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      transition: all 0.2s;
    }
    .collection-item:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
    }
    .collection-item.active {
      border-color: #00ff88;
      background: rgba(0, 255, 136, 0.05);
    }
    .collection-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      cursor: pointer;
    }
    .collection-preview {
      width: 45px;
      height: 30px;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .collection-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .collection-info {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .no-data-msg {
      font-size: 0.85rem;
      color: rgba(255, 255, 255, 0.4);
      font-style: italic;
      text-align: center;
      padding: 0.5rem 0;
    }
    .collection-name {
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .collection-count {
      color: rgba(255, 255, 255, 0.5);
      font-size: 0.7rem;
    }
    .carousel-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1.5rem;
      margin-top: 1.25rem;
      background: rgba(0, 0, 0, 0.2);
      padding: 0.75rem;
      border-radius: 12px;
    }
    .nav-btn {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.1);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .nav-btn:hover {
      background: #00d9ff;
      color: #000;
      border-color: transparent;
      transform: scale(1.1);
    }
    .nav-indicator {
      color: #fff;
      font-size: 0.9rem;
      font-weight: 600;
      font-family: monospace;
    }
    .carousel-settings {
      margin-top: 1rem;
      padding: 1rem;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .settings-header {
      font-size: 0.7rem;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.5);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 0.75rem;
    }
    .mode-toggle {
      display: flex;
      gap: 1.5rem;
      margin-bottom: 0.75rem;
    }
    .radio-label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: #fff;
      font-size: 0.85rem;
      cursor: pointer;
      font-weight: 500;
    }
    .radio-label input[type="radio"] {
      accent-color: #00d9ff;
    }
    .auto-settings {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .auto-settings label,
    .auto-settings span {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.8rem;
      font-weight: 500;
    }
    .auto-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: #00ff88;
      margin-left: auto;
      font-weight: 600;
    }
    .interval-input {
      width: 50px;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.15);
      color: #fff;
      padding: 6px;
      border-radius: 6px;
      text-align: center;
      font-weight: 600;
      outline: none;
    }
    .interval-input:focus {
      border-color: #00d9ff;
    }
    .clear-btn {
      width: 100%;
      padding: 12px;
      background: rgba(255, 50, 50, 0.1);
      color: #ff4444;
      border: 1px solid rgba(255, 50, 50, 0.2);
      border-radius: 10px;
      margin-top: 1rem;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
    }
    .clear-btn:hover {
      background: rgba(255, 50, 50, 0.2);
      border-color: #ff4444;
    }
    .pulse {
      width: 8px;
      height: 8px;
      background: #00ff88;
      border-radius: 50%;
      display: inline-block;
      box-shadow: 0 0 10px #00ff88;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.6; }
      100% { transform: scale(1); opacity: 1; }
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
