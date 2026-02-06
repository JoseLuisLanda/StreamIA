import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Scene } from '../live.models';

@Component({
  selector: 'app-scene-manager',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="scene-manager-container">
       <div class="action-bar">
         <div class="btn-group">
            <button class="action-btn update-btn" *ngIf="activeSceneId" (click)="updateScene()">
                <span class="icon">↻</span> Update
            </button>
            <button class="action-btn save-btn" (click)="saveScene()">
                <span class="icon">+</span> Save
            </button>
         </div>
       </div>
       
       <div class="scenes-list" *ngIf="scenes.length > 0">
         <div 
            class="scene-card" 
            *ngFor="let scene of scenes" 
            [class.active]="scene.id === activeSceneId"
            (click)="onLoad.emit(scene)">
           <div class="scene-info">
               <span class="scene-icon">🎬</span>
               <span class="scene-name">{{ scene.name }}</span>
           </div>
           <button class="scene-delete" (click)="deleteScene(scene.id, $event)">×</button>
         </div>
       </div>
       <p class="no-data-msg" *ngIf="scenes.length === 0">No scenes saved. Create your first scene!</p>
    </div>
  `,
  styles: [`
    .action-bar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 1rem;
    }
    .btn-group {
        display: flex;
        gap: 8px;
    }
    .action-btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: opacity 0.2s;
      color: #fff;
    }
    .action-btn:hover {
        opacity: 0.9;
    }
    .save-btn {
        background: linear-gradient(135deg, #FF3BFF, #5C24FF);
    }
    .update-btn {
        background: #23293D;
        border: 1px solid #3B4259;
        color: #E2E8F0;
    }
    .update-btn:hover {
        background: #2A3042;
    }
    .scenes-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
      gap: 0.5rem;
    }
    .scene-card {
      background: #151926;
      border: 1px solid #23293D;
      border-radius: 8px;
      padding: 10px;
      cursor: pointer;
      position: relative;
      transition: all 0.2s;
      min-height: 60px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .scene-card:hover {
      border-color: #5C24FF;
      background: #1A1E2E;
    }
    .scene-card.active {
        border-color: #A855F7;
        background: linear-gradient(135deg, rgba(168, 85, 247, 0.1), rgba(92, 36, 255, 0.1));
        box-shadow: 0 0 15px rgba(92, 36, 255, 0.15);
    }
    .scene-info {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        text-align: center;
    }
    .scene-icon {
        font-size: 1.2rem;
    }
    .scene-name {
      font-size: 0.75rem;
      color: #cbd5e1;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .scene-delete {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 20px;
      height: 20px;
      background: transparent;
      border: none;
      color: #64748b;
      cursor: pointer;
      font-size: 1.2rem;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
    }
    .scene-delete:hover {
      color: #ff4444;
      background: rgba(255, 68, 68, 0.1);
    }
    .no-data-msg {
      font-size: 0.85rem;
      color: #64748b;
      text-align: center;
      padding: 1rem 0;
      border: 1px dashed #23293D;
      border-radius: 8px;
    }
  `]
})
export class SceneManagerComponent {
  @Input() scenes: Scene[] = [];
  @Input() activeSceneId: string | null = null;
  @Output() onSave = new EventEmitter<void>();
  @Output() onUpdate = new EventEmitter<void>();
  @Output() onLoad = new EventEmitter<Scene>();
  @Output() onDelete = new EventEmitter<string>();

  saveScene() {
    this.onSave.emit();
  }

  updateScene() {
    this.onUpdate.emit();
  }

  deleteScene(id: string, event: Event) {
    event.stopPropagation();
    this.onDelete.emit(id);
  }
}
