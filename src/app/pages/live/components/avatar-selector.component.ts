import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AvatarOption, AvatarSize, ImageCollection } from '../live.models';

export interface CustomAvatarRequest {
  url: string;
  name: string;
}

@Component({
  selector: 'app-avatar-selector',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="avatar-selector-content">
      <div class="avatar-grid">
        <div 
          *ngFor="let avatar of avatars" 
          class="avatar-card" 
          [class.selected]="currentAvatar?.id === avatar.id"
          (click)="onSelect.emit(avatar)"
        >
          <button
            type="button"
            class="avatar-delete-btn"
            title="Delete avatar"
            (click)="deleteAvatar($event, avatar)">
            ×
          </button>
          <div class="avatar-thumb-wrapper">
             <img [src]="avatar.thumbnail" [alt]="avatar.name" class="avatar-thumb" />
          </div>
          <span class="avatar-name">{{ avatar.name }}</span>
          <span class="avatar-collection-badge" *ngIf="getCollectionName(avatar.defaultCollectionId)">
            {{ getCollectionName(avatar.defaultCollectionId) }}
          </span>
        </div>
      </div>
      
      <div class="control-section">
          <div class="control-row">
            <span class="control-label">Size</span>
            <div class="segmented-control">
              <button 
                *ngFor="let size of sizeOptions" 
                class="segment-btn" 
                [class.active]="avatarSize === size.value"
                (click)="onSetSize.emit(size.value)"
              >
                {{ size.label }}
              </button>
            </div>
          </div>
          
          <div class="control-row">
            <span class="control-label">Position</span>
            <div class="segmented-control">
              <button 
                *ngFor="let pos of positionOptions" 
                class="segment-btn" 
                [class.active]="avatarPosition === pos.value"
                (click)="onSetPosition.emit(pos.value)"
                [title]="pos.value"
                [style.display]="isPortrait && pos.value !== 'center' ? 'none' : 'block'"
              >
                {{ pos.label }}
              </button>
            </div>
          </div>
      </div>
      
      <div class="control-row" *ngIf="currentAvatar && collections.length > 0">
        <span class="control-label">Collection</span>
        <select class="custom-select" [(ngModel)]="currentAvatar.defaultCollectionId" (ngModelChange)="onCollectionChange.emit()">
          <option [ngValue]="undefined">None</option>
          <option *ngFor="let col of collections" [value]="col.id">{{ col.name }}</option>
        </select>
      </div>

      <div class="divider"></div>

      <div class="custom-url-section">
        <span class="section-label">Custom Avatar</span>
        <div class="url-input-group">
            <input
            type="text"
            [(ngModel)]="customName"
            placeholder="Avatar name..."
            class="custom-input"
            />
        </div>
        <div class="url-input-group">
            <input 
            type="text" 
            [(ngModel)]="customUrl" 
            placeholder="Ready Player Me URL..."
            class="custom-input"
            />
            <button (click)="loadCustom()" class="load-btn">Load</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .divider {
        height: 1px;
        background: #23293D;
        margin: 1rem 0;
    }
    .avatar-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .avatar-card {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0.75rem;
      background: #151926;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      border: 1px solid #23293D;
    }
    .avatar-card:hover {
      background: #1A1E2E;
      border-color: #5C24FF;
    }
    .avatar-card.selected {
      border-color: #A855F7;
      background: #1E2338;
      box-shadow: 0 0 0 1px #A855F7;
    }
    .avatar-delete-btn {
      position: absolute;
      top: 0.35rem;
      right: 0.35rem;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 1px solid #23293D;
      background: #0B0F19;
      color: #94A3B8;
      cursor: pointer;
      font-size: 0.9rem;
      line-height: 1;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .avatar-delete-btn:hover {
      border-color: #A855F7;
      color: #fff;
      background: #23293D;
    }
    .avatar-thumb-wrapper {
        width: 60px;
        height: 60px;
        border-radius: 50%;
        padding: 2px;
        border: 1px solid #23293D;
        margin-bottom: 0.5rem;
        background: #0B0F19;
    }
    .avatar-thumb {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      object-fit: cover;
    }
    .avatar-name {
      color: #E2E8F0;
      font-size: 0.8rem;
      font-weight: 500;
      text-align: center;
    }
    .avatar-collection-badge {
      margin-top: 0.25rem;
      font-size: 0.65rem;
      color: #10B981;
      background: rgba(16, 185, 129, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
    }
    
    /* Controls */
    .control-section {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
    }
    .control-row {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .control-label, .section-label {
      color: #94A3B8;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    /* Segmented Control (Leonardo toggle style) */
    .segmented-control {
      display: flex;
      background: #0B0F19;
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
    .segment-btn:hover {
      color: #E2E8F0;
    }
    .segment-btn.active {
      background: #23293D;
      color: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    
    /* Inputs & Selects */
    .custom-select, .custom-input {
      width: 100%;
      padding: 10px;
      border-radius: 6px;
      background: #0B0F19;
      color: #fff;
      border: 1px solid #23293D;
      font-size: 0.85rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .custom-select:focus, .custom-input:focus {
      border-color: #A855F7;
    }
    
    .url-input-group {
      display: flex;
      gap: 0.5rem;
    }
    .load-btn {
      padding: 0 16px;
      border-radius: 6px;
      background: linear-gradient(135deg, #FF3BFF, #5C24FF);
      color: #fff;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    .load-btn:hover {
      opacity: 0.9;
    }
  `]
})
export class AvatarSelectorComponent {
  @Input() avatars: AvatarOption[] = [];
  @Input() currentAvatar: AvatarOption | null = null;
  @Input() avatarSize: AvatarSize = 'medium';
  @Input() avatarPosition: 'left' | 'center' | 'right' = 'center';
  @Input() collections: ImageCollection[] = [];
  @Input() sizeOptions: any[] = [];
  @Input() positionOptions: any[] = [];
  @Input() isPortrait = false;

  @Output() onSelect = new EventEmitter<AvatarOption>();
  @Output() onSetSize = new EventEmitter<AvatarSize>();
  @Output() onSetPosition = new EventEmitter<'left' | 'center' | 'right'>();
  @Output() onCollectionChange = new EventEmitter<void>();
  @Output() onLoadCustom = new EventEmitter<CustomAvatarRequest>();
  @Output() onDelete = new EventEmitter<AvatarOption>();

  customUrl = '';
  customName = '';

  getCollectionName(id?: string) {
    if (!id) return '';
    return this.collections.find(c => c.id === id)?.name || '';
  }

  loadCustom() {
    this.onLoadCustom.emit({
      url: this.customUrl,
      name: this.customName
    });
    this.customUrl = '';
    this.customName = '';
  }

  deleteAvatar(event: Event, avatar: AvatarOption) {
    event.stopPropagation();
    this.onDelete.emit(avatar);
  }
}
