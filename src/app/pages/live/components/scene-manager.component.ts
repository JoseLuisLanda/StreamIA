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
            <button class="add-overlay-btn update-btn" *ngIf="activeSceneId" (click)="updateScene()">↻ Update</button>
            <button class="add-overlay-btn" (click)="saveScene()">+ Save</button>
         </div>
       </div>
       
       <div class="scenes-list" *ngIf="scenes.length > 0">
         <div 
            class="scene-chip" 
            *ngFor="let scene of scenes" 
            [class.active]="scene.id === activeSceneId"
            (click)="onLoad.emit(scene)">
           <span class="scene-name">{{ scene.name }}</span>
           <button class="scene-delete" (click)="deleteScene(scene.id, $event)">×</button>
         </div>
       </div>
       <p class="no-data-msg" *ngIf="scenes.length === 0">Save current layout as a scene.</p>
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
    .update-btn {
        border-color: rgba(255, 200, 0, 0.3);
        background: rgba(255, 200, 0, 0.1);
        color: #ffc800;
    }
    .update-btn:hover {
        background: #ffc800;
        color: #000;
    }
    .scenes-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .scene-chip {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      padding: 8px 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .scene-chip:hover {
      background: rgba(0, 217, 255, 0.1);
      border-color: #00d9ff;
      transform: translateY(-2px);
    }
    .scene-chip.active {
        background: rgba(0, 217, 255, 0.15);
        border-color: #00d9ff;
        box-shadow: 0 0 10px rgba(0, 217, 255, 0.2);
    }
    .scene-name {
      font-size: 0.85rem;
      color: #fff;
      font-weight: 500;
    }
    .scene-delete {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.3);
      cursor: pointer;
      font-size: 1.1rem;
      padding: 0;
      line-height: 1;
      transition: color 0.2s;
    }
    .scene-delete:hover {
      color: #ff4444;
    }
    .no-data-msg {
      font-size: 0.85rem;
      color: rgba(255, 255, 255, 0.4);
      font-style: italic;
      text-align: center;
      padding: 0.5rem 0;
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
