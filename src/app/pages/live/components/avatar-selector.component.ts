import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AvatarOption, AvatarSize, ImageCollection } from '../live.models';

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
          <img [src]="avatar.thumbnail" [alt]="avatar.name" class="avatar-thumb" />
          <span class="avatar-name">{{ avatar.name }}</span>
          <span class="avatar-collection-badge" *ngIf="getCollectionName(avatar.defaultCollectionId)">
            📁 {{ getCollectionName(avatar.defaultCollectionId) }}
          </span>
        </div>
      </div>
      
      <div class="control-row">
        <span class="control-label">Size:</span>
        <div class="control-buttons">
          <button 
            *ngFor="let size of sizeOptions" 
            class="control-btn" 
            [class.active]="avatarSize === size.value"
            (click)="onSetSize.emit(size.value)"
          >
            {{ size.label }}
          </button>
        </div>
      </div>
      
      <div class="control-row">
        <span class="control-label">Pos:</span>
        <div class="control-buttons">
          <button 
            *ngFor="let pos of positionOptions" 
            class="control-btn" 
            [class.active]="avatarPosition === pos.value"
            (click)="onSetPosition.emit(pos.value)"
            [title]="pos.value"
          >
            {{ pos.label }}
          </button>
        </div>
      </div>
      
      <div class="assign-collection" *ngIf="currentAvatar && collections.length > 0">
        <label>Default Collection:</label>
        <select [(ngModel)]="currentAvatar.defaultCollectionId" (ngModelChange)="onCollectionChange.emit()">
          <option [ngValue]="undefined">None</option>
          <option *ngFor="let col of collections" [value]="col.id">{{ col.name }}</option>
        </select>
      </div>

      <div class="divider"></div>

      <div class="url-input-group">
        <input 
          type="text" 
          [(ngModel)]="customUrl" 
          placeholder="Paste Ready Player Me URL"
          class="url-input"
        />
        <button (click)="loadCustom()" class="load-btn">Load</button>
      </div>
    </div>
  `,
  styles: [`
    .divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.1);
        margin: 1.5rem 0;
    }
    .avatar-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .avatar-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0.75rem;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .avatar-card:hover {
      background: rgba(255, 255, 255, 0.08);
      transform: translateY(-2px);
      border-color: rgba(0, 217, 255, 0.3);
    }
    .avatar-card.selected {
      border-color: #00d9ff;
      background: rgba(0, 217, 255, 0.1);
      box-shadow: 0 0 15px rgba(0, 217, 255, 0.2);
    }
    .avatar-thumb {
      width: 70px;
      height: 70px;
      border-radius: 50%;
      object-fit: cover;
      background: rgba(0, 0, 0, 0.3);
      border: 2px solid rgba(255, 255, 255, 0.1);
    }
    .avatar-name {
      margin-top: 0.5rem;
      color: rgba(255, 255, 255, 0.9);
      font-size: 0.85rem;
      font-weight: 500;
      text-align: center;
    }
    .avatar-collection-badge {
      margin-top: 0.25rem;
      font-size: 0.65rem;
      color: #00ff88;
      background: rgba(0, 255, 136, 0.1);
      padding: 2px 8px;
      border-radius: 10px;
    }
    .control-row {
      margin-top: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .control-label {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.75rem;
      min-width: 45px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .control-buttons {
      display: flex;
      gap: 0.5rem;
      flex: 1;
    }
    .control-btn {
      flex: 1;
      padding: 10px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 600;
      transition: all 0.2s;
      text-align: center;
    }
    .control-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.25);
    }
    .control-btn.active {
      background: linear-gradient(135deg, #00d9ff, #00ff88);
      color: #fff;
      border-color: transparent;
      box-shadow: 0 4px 10px rgba(0, 217, 255, 0.3);
    }
    .assign-collection {
      margin-top: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .assign-collection label {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .assign-collection select {
      width: 100%;
      padding: 12px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.4);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      font-size: 0.9rem;
      outline: none;
      cursor: pointer;
    }
    .assign-collection select:focus {
      border-color: #00d9ff;
    }
    .url-input-group {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .url-input {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.3);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      font-size: 0.85rem;
      outline: none;
      transition: all 0.2s;
    }
    .url-input::placeholder {
      color: rgba(255, 255, 255, 0.4);
    }
    .url-input:focus {
      border-color: #00d9ff;
      background: rgba(0, 0, 0, 0.5);
    }
    .load-btn {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      background: linear-gradient(135deg, #00d9ff, #00ff88);
      color: #fff;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .load-btn:hover {
      transform: scale(1.02);
      box-shadow: 0 5px 15px rgba(0, 217, 255, 0.4);
    }
    .load-btn:active {
      transform: scale(0.98);
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

  @Output() onSelect = new EventEmitter<AvatarOption>();
  @Output() onSetSize = new EventEmitter<AvatarSize>();
  @Output() onSetPosition = new EventEmitter<'left' | 'center' | 'right'>();
  @Output() onCollectionChange = new EventEmitter<void>();
  @Output() onLoadCustom = new EventEmitter<string>();

  customUrl = '';

  getCollectionName(id?: string) {
    if (!id) return '';
    return this.collections.find(c => c.id === id)?.name || '';
  }

  loadCustom() {
    this.onLoadCustom.emit(this.customUrl);
    this.customUrl = '';
  }
}
