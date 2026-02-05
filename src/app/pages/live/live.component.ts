import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AvatarViewerComponent } from '../../components/avatar-viewer/avatar-viewer.component';
import { VideoPreviewComponent } from '../../components/video-preview/video-preview.component';
import { MediaOverlayComponent, MediaOverlay, MediaItem } from '../../components/media-overlay/media-overlay.component';

interface AvatarOption {
  id: string;
  name: string;
  url: string;
  thumbnail: string;
  defaultCollectionId?: string;
}

interface ImageCollection {
  id: string;
  name: string;
  images: string[];
}

type AvatarSize = 'small' | 'medium' | 'large';

@Component({
  selector: 'app-live',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, AvatarViewerComponent, VideoPreviewComponent, MediaOverlayComponent],
  template: `
    <div class="app-container">
      <!-- Avatar Container - adjusts based on panel state -->
      <div class="avatar-wrapper" [class.panel-open]="isPanelOpen">
        <app-avatar-viewer 
          #avatarViewer
          [avatarUrl]="currentAvatarUrl" 
          [backgroundImage]="currentBackground"
          [avatarSize]="avatarSize"
        ></app-avatar-viewer>
        
        <!-- Media Overlays Container -->
        <div class="overlays-container" [class.free-move]="isFreeMoveMode" *ngIf="mediaOverlays.length > 0">
          <app-media-overlay
            *ngFor="let overlay of mediaOverlays"
            [overlay]="overlay"
            [width]="overlayWidth"
            [height]="overlayHeight"
            [draggable]="isFreeMoveMode"
            (onRemove)="removeOverlay($event)"
            (onUpdate)="updateOverlay($event)"
            (onPositionChange)="updateOverlay($event)"
          ></app-media-overlay>
        </div>
      </div>
      
      <!-- Slide Panel Toggle Button -->
      <button class="panel-toggle" (click)="togglePanel()" [class.panel-open]="isPanelOpen">
        <span class="toggle-icon">{{ isPanelOpen ? '◀' : '▶' }}</span>
      </button>
      
      <!-- Sliding Side Panel -->
      <div class="side-panel" [class.open]="isPanelOpen">
        <div class="panel-content">
          <h3>Controls</h3>
          
          <!-- Camera Preview -->
          <div class="section">
            <h4>📹 Camera</h4>
            <div class="camera-container">
              <app-video-preview></app-video-preview>
            </div>
          </div>
          
          <!-- Avatar Selection -->
          <div class="section">
            <h4>🎭 Select Avatar</h4>
            <div class="avatar-grid">
              <div 
                *ngFor="let avatar of avatars" 
                class="avatar-card" 
                [class.selected]="currentAvatar?.id === avatar.id"
                (click)="selectAvatar(avatar)"
              >
                <img [src]="avatar.thumbnail" [alt]="avatar.name" class="avatar-thumb" />
                <span class="avatar-name">{{ avatar.name }}</span>
                <span class="avatar-collection-badge" *ngIf="getCollectionName(avatar.defaultCollectionId)">
                  📁 {{ getCollectionName(avatar.defaultCollectionId) }}
                </span>
              </div>
            </div>
            
            <!-- Avatar Size Control -->
            <div class="size-control">
              <span class="size-label">Size:</span>
              <div class="size-buttons">
                <button 
                  *ngFor="let size of sizeOptions" 
                  class="size-btn" 
                  [class.active]="avatarSize === size.value"
                  (click)="setAvatarSize(size.value)"
                >
                  {{ size.label }}
                </button>
              </div>
            </div>
            
            <!-- Assign Collection to Current Avatar -->
            <div class="assign-collection" *ngIf="currentAvatar && collections.length > 0">
              <label>Default Collection:</label>
              <select [(ngModel)]="currentAvatar.defaultCollectionId" (ngModelChange)="onAvatarCollectionChange()">
                <option [ngValue]="undefined">None</option>
                <option *ngFor="let col of collections" [value]="col.id">{{ col.name }}</option>
              </select>
            </div>
          </div>

          <!-- Media Overlays Management -->
          <div class="section">
            <div class="section-header">
              <h4>📺 Media Screens</h4>
              <div class="header-controls">
                <button 
                  class="icon-btn" 
                  [class.active]="isFreeMoveMode" 
                  (click)="toggleFreeMoveMode()"
                  title="Toggle Free Move Mode"
                >
                  ✋
                </button>
                <button class="add-overlay-btn" (click)="addOverlay()">+ Add</button>
              </div>
            </div>
            
            <!-- Global Overlay Settings -->
            <div class="overlay-settings" *ngIf="mediaOverlays.length > 0">
              <div class="setting-row">
                <label>Width:</label>
                <input type="range" [(ngModel)]="overlayWidth" min="150" max="800" step="10">
              </div>
               <div class="setting-row">
                <label>Height:</label>
                <input type="range" [(ngModel)]="overlayHeight" min="100" max="600" step="10">
              </div>
            </div>

            <!-- List of Overlays -->
            <div class="overlays-list" *ngIf="mediaOverlays.length > 0">
              <div class="item-card" *ngFor="let overlay of mediaOverlays">
                <div class="item-header">
                  <span class="item-name">{{ overlay.name }}</span>
                  <button class="item-remove" (click)="removeOverlay(overlay.id)">🗑️</button>
                </div>
                
                <!-- Assign Collection to Screen -->
                <div class="item-controls" *ngIf="collections.length > 0">
                  <select 
                    [ngModel]="''" 
                    (ngModelChange)="assignCollectionToOverlay(overlay, $event)"
                    class="collection-select"
                  >
                    <option value="" disabled selected>Select content...</option>
                    <option *ngFor="let col of collections" [value]="col.id">{{ col.name }}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Custom Avatar URL Section -->
          <div class="section">
            <h4>🔗 Custom Avatar</h4>
            <div class="url-input-group">
              <input 
                type="text" 
                [(ngModel)]="customUrl" 
                placeholder="Paste Ready Player Me URL"
                class="url-input"
              />
              <button (click)="loadCustomAvatar()" class="load-btn">Load</button>
            </div>
          </div>
          
          <!-- Background Collections Section -->
          <div class="section">
            <h4>🖼️ Background Collections</h4>
            
            <!-- Create New Collection -->
            <div class="new-collection">
              <input 
                type="text" 
                [(ngModel)]="newCollectionName" 
                placeholder="Collection name *"
                class="collection-name-input"
                [class.required]="!newCollectionName.trim()"
              />
              <input 
                type="file" 
                #fileInput 
                (change)="onFilesSelected($event)" 
                accept="image/*" 
                multiple 
                style="display: none"
              />
              <button 
                class="upload-btn" 
                [class.disabled]="!newCollectionName.trim()"
                [disabled]="!newCollectionName.trim()"
                (click)="fileInput.click()"
              >
                + Add
              </button>
            </div>
            
            <!-- Collections List -->
            <div class="collections-list" *ngIf="collections.length > 0">
              <div 
                *ngFor="let collection of collections" 
                class="collection-item"
                [class.active]="activeCollection?.id === collection.id"
              >
                <div class="collection-header" (click)="selectCollection(collection)">
                  <div class="collection-preview">
                    <img *ngIf="collection.images[0]" [src]="collection.images[0]" alt="Preview" />
                  </div>
                  <div class="collection-info">
                    <span class="collection-name">{{ collection.name }}</span>
                    <span class="collection-count">{{ collection.images.length }} images</span>
                  </div>
                  <button class="delete-collection" (click)="deleteCollection(collection, $event)">🗑️</button>
                </div>
              </div>
            </div>
            
            <!-- No Collections Message -->
            <div class="no-collections" *ngIf="collections.length === 0">
              <p>No collections yet. Create one above!</p>
            </div>
            
            <!-- Carousel Controls (moved here) -->
            <div class="carousel-controls-panel" *ngIf="activeCollection && activeCollection.images.length > 1">
              <div class="carousel-nav">
                <button class="nav-btn" (click)="prevBackground()">◀</button>
                <span class="nav-indicator">{{ currentBackgroundIndex + 1 }} / {{ activeCollection.images.length }}</span>
                <button class="nav-btn" (click)="nextBackground()">▶</button>
              </div>
            </div>
            
            <!-- Carousel Settings -->
            <div class="carousel-settings" *ngIf="activeCollection && activeCollection.images.length > 1">
              <div class="settings-header">
                <span>🎠 Carousel Settings</span>
              </div>
              <div class="mode-toggle">
                <label class="radio-label">
                  <input type="radio" name="carouselMode" value="manual" [(ngModel)]="carouselMode" (ngModelChange)="onModeChange()" />
                  <span>Manual</span>
                </label>
                <label class="radio-label">
                  <input type="radio" name="carouselMode" value="auto" [(ngModel)]="carouselMode" (ngModelChange)="onModeChange()" />
                  <span>Auto Loop</span>
                </label>
              </div>
              
              <!-- Auto Settings -->
              <div class="auto-settings" *ngIf="carouselMode === 'auto'">
                <label>Interval:</label>
                <input 
                  type="number" 
                  [(ngModel)]="autoIntervalSeconds" 
                  min="1" 
                  max="60"
                  class="interval-input"
                  (ngModelChange)="onIntervalChange()"
                />
                <span>sec</span>
                <span class="auto-status">
                  <span class="pulse"></span> Running
                </span>
              </div>
            </div>
            
            <!-- Clear Active -->
            <button class="clear-btn" *ngIf="activeCollection" (click)="clearActiveCollection()">
              Deselect Collection
            </button>
          </div>
          
          <!-- Back Button -->
          <a routerLink="/" class="back-btn">← Back to Home</a>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .app-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: #111;
    }
    
    /* Avatar Wrapper - adjusts when panel opens */
    .avatar-wrapper {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      transition: left 0.3s ease, width 0.3s ease;
    }
    .avatar-wrapper.panel-open {
      left: 320px;
      width: calc(100% - 320px);
    }
    
    .overlays-container {
      position: absolute;
      top: 20px;
      left: 0;
      right: 0;
      display: flex;
      justify-content: center;
      gap: 20px;
      z-index: 100;
      pointer-events: none; /* Allow clicking through empty spaces */
    }
    .overlays-container > * {
      pointer-events: auto; /* Re-enable pointer events for overlays */
    }
    
    /* Panel Toggle Button */
    .panel-toggle {
      position: fixed;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2000;
      width: 30px;
      height: 60px;
      background: rgba(0, 0, 0, 0.7);
      border: none;
      border-radius: 0 8px 8px 0;
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      backdrop-filter: blur(10px);
    }
    .panel-toggle:hover {
      background: rgba(0, 0, 0, 0.9);
      width: 35px;
    }
    .panel-toggle.panel-open {
      left: 320px;
    }
    .toggle-icon {
      font-size: 14px;
    }
    
    /* Side Panel */
    .side-panel {
      position: fixed;
      left: -320px;
      top: 0;
      width: 320px;
      height: 100vh;
      background: linear-gradient(180deg, rgba(20, 20, 30, 0.98) 0%, rgba(10, 10, 20, 1) 100%);
      backdrop-filter: blur(20px);
      z-index: 1500;
      transition: left 0.3s ease;
      overflow-y: auto;
      overflow-x: hidden;
      border-right: 1px solid rgba(255, 255, 255, 0.1);
    }
    .side-panel.open {
      left: 0;
    }
    
    .panel-content {
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }
    
    .panel-content h3 {
      margin: 0;
      color: white;
      font-family: 'Segoe UI', sans-serif;
      font-size: 1.5rem;
      font-weight: 600;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid rgba(0, 217, 255, 0.5);
    }
    
    .section {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 12px;
      padding: 1rem;
    }
    
    .section h4 {
      margin: 0 0 0.75rem 0;
      color: rgba(255, 255, 255, 0.9);
      font-family: 'Segoe UI', sans-serif;
      font-size: 0.95rem;
      font-weight: 500;
    }
    
    /* Camera Section */
    .camera-container {
      position: relative;
      width: 100%;
      height: 160px;
      border-radius: 8px;
      overflow: hidden;
      background: #000;
    }
    
    /* Avatar Grid */
    .avatar-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
    }
    
    .avatar-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0.75rem;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
      border: 2px solid transparent;
    }
    .avatar-card:hover {
      background: rgba(255, 255, 255, 0.1);
      transform: scale(1.02);
    }
    .avatar-card.selected {
      border-color: #00d9ff;
      background: rgba(0, 217, 255, 0.1);
    }
    
    .avatar-thumb {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      object-fit: cover;
      background: rgba(0, 0, 0, 0.3);
    }
    
    .avatar-name {
      margin-top: 0.5rem;
      color: white;
      font-size: 0.85rem;
      font-family: 'Segoe UI', sans-serif;
      text-align: center;
    }
    
    .avatar-collection-badge {
      margin-top: 0.25rem;
      font-size: 0.7rem;
      color: rgba(0, 255, 136, 0.8);
      background: rgba(0, 255, 136, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
    }
    
    /* Size Control */
    .size-control {
      margin-top: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    
    .size-label {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.85rem;
    }
    
    .size-buttons {
      display: flex;
      gap: 0.25rem;
      flex: 1;
    }
    
    .size-btn {
      flex: 1;
      padding: 8px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.3);
      color: white;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: all 0.2s;
    }
    .size-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .size-btn.active {
      background: linear-gradient(135deg, #00d9ff, #00ff88);
      color: black;
      border-color: transparent;
      font-weight: bold;
    }
    
    /* Assign Collection */
    .assign-collection {
      margin-top: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .assign-collection label {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.8rem;
      white-space: nowrap;
    }
    
    .assign-collection select {
      flex: 1;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.4);
      color: white;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .assign-collection select option {
      background: #1a1a2e;
    }
    
    /* URL Input */
    .url-input-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    
    .url-input {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.4);
      color: white;
      font-size: 12px;
      outline: none;
      box-sizing: border-box;
    }
    .url-input::placeholder {
      color: rgba(255, 255, 255, 0.4);
    }
    .url-input:focus {
      border-color: #00d9ff;
      box-shadow: 0 0 10px rgba(0, 217, 255, 0.2);
    }
    
    .load-btn {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: none;
      background: linear-gradient(135deg, #00d9ff, #00ff88);
      color: black;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s;
    }
    .load-btn:hover {
      transform: scale(1.02);
      box-shadow: 0 4px 15px rgba(0, 217, 255, 0.3);
    }
    
    /* New Collection */
    .new-collection {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    
    .collection-name-input {
      flex: 1;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.4);
      color: white;
      font-size: 12px;
      outline: none;
    }
    .collection-name-input::placeholder {
      color: rgba(255, 255, 255, 0.4);
    }
    
    .upload-btn {
      padding: 10px 16px;
      border-radius: 8px;
      border: none;
      background: linear-gradient(135deg, #00d9ff, #00ff88);
    }

    /* Media Overlays Controls */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }
    
    .add-overlay-btn {
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid rgba(0, 217, 255, 0.5);
      background: rgba(0, 217, 255, 0.1);
      color: #00d9ff;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .add-overlay-btn:hover {
      background: rgba(0, 217, 255, 0.2);
    }
    
    .overlay-settings {
      margin-bottom: 1rem;
      padding: 0.75rem;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 8px;
    }
    
    .setting-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .setting-row:last-child {
      margin-bottom: 0;
    }
    
    .setting-row label {
      width: 50px;
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.8rem;
    }
    
    .setting-row input[type="range"] {
      flex: 1;
      accent-color: #00d9ff;
    }
    
    .item-card {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 6px;
      padding: 0.5rem;
      margin-bottom: 0.5rem;
    }
    
    .item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }
    
    .item-name {
      color: white;
      font-size: 0.85rem;
      font-weight: 500;
    }
    
    .item-remove {
      background: transparent;
      border: none;
      cursor: pointer;
      opacity: 0.6;
    }
    .item-remove:hover {
      opacity: 1;
    }
    
    .collection-select {
      width: 100%;
      padding: 6px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      font-size: 0.8rem;
    }

    .upload-btn.disabled {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.4);
      cursor: not-allowed;
    }
    
    .collection-name-input.required {
      border-color: rgba(255, 100, 100, 0.5);
    }
    .collection-name-input:focus {
      border-color: #00d9ff;
    }
    
    /* Collections List */
    .collections-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 180px;
      overflow-y: auto;
    }
    
    .collection-item {
      background: rgba(0, 0, 0, 0.3);
      border-radius: 8px;
      border: 2px solid transparent;
      transition: all 0.2s;
    }
    .collection-item.active {
      border-color: #00ff88;
      background: rgba(0, 255, 136, 0.1);
    }
    
    .collection-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem;
      cursor: pointer;
    }
    .collection-header:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    
    .collection-preview {
      width: 50px;
      height: 35px;
      border-radius: 4px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.5);
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
    .collection-name {
      color: white;
      font-size: 0.9rem;
      font-weight: 500;
    }
    .collection-count {
      color: rgba(255, 255, 255, 0.5);
      font-size: 0.75rem;
    }
    
    .delete-collection {
      padding: 4px 8px;
      background: transparent;
      border: none;
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.2s;
    }
    .delete-collection:hover {
      opacity: 1;
    }
    
    .no-collections {
      text-align: center;
      padding: 1rem;
      color: rgba(255, 255, 255, 0.4);
      font-size: 0.85rem;
    }
    
    /* Carousel Controls in Panel */
    .carousel-controls-panel {
      margin-top: 0.75rem;
      padding: 0.75rem;
      background: rgba(0, 217, 255, 0.1);
      border-radius: 8px;
      border: 1px solid rgba(0, 217, 255, 0.3);
    }
    
    .carousel-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
    }
    
    .nav-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: rgba(0, 217, 255, 0.3);
      color: white;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }
    .nav-btn:hover {
      background: rgba(0, 217, 255, 0.5);
      transform: scale(1.1);
    }
    
    .nav-indicator {
      color: white;
      font-size: 0.9rem;
      min-width: 50px;
      text-align: center;
    }
    
    .icon-btn {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.1);
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .icon-btn.active {
      background: rgba(0, 217, 255, 0.3);
      border-color: #00d9ff;
      color: #00d9ff;
    }
    .icon-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }
    
    .header-controls {
      display: flex;
      gap: 0.5rem;
    }
    
    /* Carousel Settings */
    .carousel-settings {
      margin-top: 0.5rem;
      padding: 0.75rem;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 8px;
    }
    
    .settings-header {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.85rem;
      margin-bottom: 0.5rem;
    }
    
    .mode-toggle {
      display: flex;
      gap: 1rem;
      margin-bottom: 0.5rem;
    }
    
    .radio-label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: white;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .radio-label input[type="radio"] {
      accent-color: #00d9ff;
    }
    
    .auto-settings {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .auto-settings label, .auto-settings span {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.8rem;
    }
    
    .auto-status {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      color: #00ff88 !important;
      margin-left: auto;
    }
    
    .pulse {
      width: 8px;
      height: 8px;
      background: #00ff88;
      border-radius: 50%;
      animation: pulse 1s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }
    
    .interval-input {
      width: 50px;
      padding: 6px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(0, 0, 0, 0.4);
      color: white;
      font-size: 0.85rem;
      text-align: center;
    }
    
    .clear-btn {
      width: 100%;
      padding: 8px;
      border-radius: 6px;
      border: none;
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.2s;
      margin-top: 0.75rem;
    }
    .clear-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }
    
    /* Back Button */
    .back-btn {
      display: block;
      text-align: center;
      padding: 12px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.1);
      color: white;
      text-decoration: none;
      font-family: 'Segoe UI', sans-serif;
      font-weight: 500;
      transition: all 0.2s;
    }
    .back-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }
  `]
})
export class LiveComponent implements OnInit, OnDestroy {
  @ViewChild('avatarViewer') avatarViewer!: AvatarViewerComponent;

  avatars: AvatarOption[] = [
    {
      id: 'avatar1',
      name: 'Avatar 1',
      url: 'https://models.readyplayer.me/6984a7a905b43df7aaeb9df1.glb',
      thumbnail: 'https://models.readyplayer.me/6984a7a905b43df7aaeb9df1.png'
    },
    {
      id: 'avatar2',
      name: 'Avatar 2',
      url: 'https://models.readyplayer.me/6984ad1a0b547ce9ae29d70d.glb',
      thumbnail: 'https://models.readyplayer.me/6984ad1a0b547ce9ae29d70d.png'
    }
  ];

  sizeOptions = [
    { label: 'S', value: 'small' as AvatarSize },
    { label: 'M', value: 'medium' as AvatarSize },
    { label: 'L', value: 'large' as AvatarSize }
  ];

  currentAvatar: AvatarOption | null = null;
  currentAvatarUrl = '';
  customUrl = '';
  isPanelOpen = false;
  avatarSize: AvatarSize = 'medium';

  // Collections
  collections: ImageCollection[] = [];
  activeCollection: ImageCollection | null = null;
  newCollectionName = '';

  // Media Overlays
  mediaOverlays: MediaOverlay[] = [];
  overlayWidth = 320;
  overlayHeight = 180;
  isFreeMoveMode = false;

  toggleFreeMoveMode() {
    this.isFreeMoveMode = !this.isFreeMoveMode;

    if (this.isFreeMoveMode) {
      // Logic to initialize positions if needed when switching to free move
      // e.g. distribute them so they don't stack on top of each other
      if (this.mediaOverlays.length > 0) {
        this.mediaOverlays.forEach((overlay, index) => {
          if (!overlay.position) {
            // Distribute horizontally with some padding
            // Center roughly in the screen
            const startX = (window.innerWidth - (this.mediaOverlays.length * (this.overlayWidth + 20))) / 2;
            overlay.position = {
              x: startX + (index * (this.overlayWidth + 20)),
              y: 50
            };
          }
        });
      }
    }
  }

  // Background settings
  currentBackgroundIndex = 0;
  currentBackground: string | null = null;
  carouselMode: 'manual' | 'auto' = 'auto';
  autoIntervalSeconds = 5;
  private autoChangeInterval: ReturnType<typeof setInterval> | null = null;

  ngOnInit() {
    // Load collections first
    this.loadCollectionsFromStorage();
    console.log('Loaded collections:', this.collections.map(c => ({ id: c.id, name: c.name })));

    // Then load avatar settings (which reference collections)
    this.loadAvatarsFromStorage();
    console.log('Loaded avatar settings:', this.avatars.map(a => ({ id: a.id, name: a.name, defaultCollectionId: a.defaultCollectionId })));

    // Select first avatar by default (this will trigger collection switch if assigned)
    if (this.avatars.length > 0) {
      this.selectAvatar(this.avatars[0]);
    }
  }

  ngOnDestroy() {
    this.stopAutoChange();
  }

  // Media Overlay Methods
  addOverlay() {
    const newOverlay: MediaOverlay = {
      id: Date.now().toString(),
      name: `Screen ${this.mediaOverlays.length + 1}`,
      items: [],
      currentIndex: 0,
      isPlaying: false,
      autoLoop: true,
      intervalSeconds: 3
    };
    this.mediaOverlays.push(newOverlay);
  }

  removeOverlay(id: string) {
    this.mediaOverlays = this.mediaOverlays.filter(o => o.id !== id);
  }

  updateOverlay(updated: MediaOverlay) {
    const index = this.mediaOverlays.findIndex(o => o.id === updated.id);
    if (index !== -1) {
      this.mediaOverlays[index] = updated;
    }
  }

  assignCollectionToOverlay(overlay: MediaOverlay, collectionId: string) {
    const collection = this.collections.find(c => c.id === collectionId);
    if (collection) {
      overlay.items = collection.images.map(url => ({
        type: 'image',
        url: url
      }));
      overlay.name = collection.name;
      overlay.currentIndex = 0;
    }
  }

  togglePanel() {
    this.isPanelOpen = !this.isPanelOpen;
    // Force avatar viewer to resize after panel animation completes
    setTimeout(() => {
      if (this.avatarViewer) {
        this.avatarViewer.forceResize();
      }
    }, 350);
  }

  selectAvatar(avatar: AvatarOption) {
    this.currentAvatar = avatar;
    this.currentAvatarUrl = avatar.url;
    console.log('Selected avatar:', avatar.name, 'defaultCollectionId:', avatar.defaultCollectionId);

    // If avatar has a default collection, switch to it
    if (avatar.defaultCollectionId) {
      const collection = this.collections.find(c => c.id === avatar.defaultCollectionId);
      console.log('Found collection:', collection?.name);
      if (collection) {
        this.selectCollection(collection);
      } else {
        // Collection was deleted, clear the reference
        avatar.defaultCollectionId = undefined;
        this.saveAvatarsToStorage();
        this.clearActiveCollection();
      }
    } else {
      // Avatar has no default collection, clear active
      this.clearActiveCollection();
    }
  }

  setAvatarSize(size: AvatarSize) {
    this.avatarSize = size;
  }

  getCollectionName(collectionId: string | undefined): string {
    if (!collectionId) return '';
    const collection = this.collections.find(c => c.id === collectionId);
    return collection?.name || '';
  }

  onAvatarCollectionChange() {
    this.saveAvatarsToStorage();

    // If current avatar's collection changed, switch to it
    if (this.currentAvatar?.defaultCollectionId) {
      const collection = this.collections.find(c => c.id === this.currentAvatar!.defaultCollectionId);
      if (collection) {
        this.selectCollection(collection);
      }
    }
  }

  loadCustomAvatar() {
    if (this.customUrl && this.customUrl.trim()) {
      let url = this.customUrl.trim();
      if (!url.endsWith('.glb')) {
        url += '.glb';
      }
      this.currentAvatarUrl = url;
      this.currentAvatar = null; // Deselect any avatar card
      console.log('Loading custom avatar:', url);
    }
  }

  // Collection methods
  onFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const collectionName = this.newCollectionName.trim() || `Collection ${this.collections.length + 1}`;
    const newCollection: ImageCollection = {
      id: Date.now().toString(),
      name: collectionName,
      images: []
    };

    const filesArray = Array.from(input.files);
    let loadedCount = 0;

    filesArray.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        newCollection.images.push(dataUrl);
        loadedCount++;

        if (loadedCount === filesArray.length) {
          this.collections.push(newCollection);
          this.saveCollectionsToStorage();
          this.newCollectionName = '';
          this.selectCollection(newCollection);
        }
      };
      reader.readAsDataURL(file);
    });

    input.value = '';
  }

  selectCollection(collection: ImageCollection) {
    this.activeCollection = collection;
    this.currentBackgroundIndex = 0;
    this.updateCurrentBackground();

    if (this.carouselMode === 'auto' && collection.images.length > 1) {
      this.startAutoChange();
    }
  }

  deleteCollection(collection: ImageCollection, event: Event) {
    event.stopPropagation();
    const index = this.collections.findIndex(c => c.id === collection.id);
    if (index !== -1) {
      this.collections.splice(index, 1);
      this.saveCollectionsToStorage();

      // Clear default collection from any avatars using it
      this.avatars.forEach(avatar => {
        if (avatar.defaultCollectionId === collection.id) {
          avatar.defaultCollectionId = undefined;
        }
      });
      this.saveAvatarsToStorage();

      if (this.activeCollection?.id === collection.id) {
        this.clearActiveCollection();
      }
    }
  }

  clearActiveCollection() {
    this.stopAutoChange();
    this.activeCollection = null;
    this.currentBackground = null;
    this.currentBackgroundIndex = 0;
  }

  prevBackground() {
    if (!this.activeCollection || this.activeCollection.images.length === 0) return;

    this.currentBackgroundIndex = this.currentBackgroundIndex === 0
      ? this.activeCollection.images.length - 1
      : this.currentBackgroundIndex - 1;
    this.updateCurrentBackground();
  }

  nextBackground() {
    if (!this.activeCollection || this.activeCollection.images.length === 0) return;

    this.currentBackgroundIndex = (this.currentBackgroundIndex + 1) % this.activeCollection.images.length;
    this.updateCurrentBackground();
  }

  private updateCurrentBackground() {
    if (this.activeCollection && this.activeCollection.images.length > 0) {
      this.currentBackground = this.activeCollection.images[this.currentBackgroundIndex];
    } else {
      this.currentBackground = null;
    }
  }

  onModeChange() {
    if (this.carouselMode === 'auto') {
      this.startAutoChange();
    } else {
      this.stopAutoChange();
    }
  }

  onIntervalChange() {
    if (this.carouselMode === 'auto') {
      this.startAutoChange();
    }
  }

  private startAutoChange() {
    this.stopAutoChange();

    if (!this.activeCollection || this.activeCollection.images.length <= 1) return;

    this.autoChangeInterval = setInterval(() => {
      this.nextBackground();
    }, this.autoIntervalSeconds * 1000);
  }

  private stopAutoChange() {
    if (this.autoChangeInterval) {
      clearInterval(this.autoChangeInterval);
      this.autoChangeInterval = null;
    }
  }

  // Storage
  private saveCollectionsToStorage() {
    try {
      localStorage.setItem('bgCollections', JSON.stringify(this.collections));
    } catch (e) {
      console.warn('Could not save collections to storage:', e);
    }
  }

  private loadCollectionsFromStorage() {
    try {
      const saved = localStorage.getItem('bgCollections');
      if (saved) {
        this.collections = JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Could not load collections from storage:', e);
    }
  }

  private saveAvatarsToStorage() {
    try {
      // Only save the collection assignments
      const avatarSettings = this.avatars.map(a => ({
        id: a.id,
        defaultCollectionId: a.defaultCollectionId
      }));
      localStorage.setItem('avatarSettings', JSON.stringify(avatarSettings));
    } catch (e) {
      console.warn('Could not save avatar settings:', e);
    }
  }

  private loadAvatarsFromStorage() {
    try {
      const saved = localStorage.getItem('avatarSettings');
      if (saved) {
        const settings = JSON.parse(saved);
        settings.forEach((setting: { id: string; defaultCollectionId?: string }) => {
          const avatar = this.avatars.find(a => a.id === setting.id);
          if (avatar) {
            avatar.defaultCollectionId = setting.defaultCollectionId;
          }
        });
      }
    } catch (e) {
      console.warn('Could not load avatar settings:', e);
    }
  }
}
