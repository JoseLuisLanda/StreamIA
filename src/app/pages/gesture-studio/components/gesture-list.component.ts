import { Component, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GestureDef, GESTURE_LIBRARY } from '../../../lib/gestures/gesture-library';
import { CustomGestureRegistryService } from '../../../services/custom-gesture-registry.service';
import { MotionStoreService } from '../../../services/motion-store.service';
import { MotionRecording } from '../../../lib/motion/motion.models';
import { GesturePlayerService } from '../../../services/gesture-player.service';

export type ListItem =
    | { kind: 'builtin'; def: GestureDef }
    | { kind: 'custom'; rec: MotionRecording; def: GestureDef | null };

@Component({
    selector: 'app-gesture-list',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div class="list-wrap">
      <!-- Built-in -->
      <div class="group-head">Built-in ({{ builtins.length }})</div>
      <div class="item" *ngFor="let def of builtins"
           [class.sel]="selectedId === def.id"
           (click)="selectBuiltin(def)">
        <span class="dot builtin"></span>
        <span class="name">{{ def.id }}</span>
        <button class="play-btn" (click)="$event.stopPropagation(); preview(def.id)"
                title="Preview gesture">▶</button>
      </div>

      <!-- Custom -->
      <div class="group-head" style="margin-top:14px">
        Custom ({{ store.recordings().length }})
      </div>
      <div class="empty" *ngIf="store.recordings().length === 0">
        No recordings yet — use Record to capture one.
      </div>
      <div class="item" *ngFor="let rec of store.recordings()"
           [class.sel]="selectedId === rec.id"
           [class.uncompiled]="!rec.compiledGesture"
           (click)="selectCustom(rec)">
        <span class="dot" [class.custom]="rec.compiledGesture" [class.draft]="!rec.compiledGesture"></span>
        <span class="name">{{ rec.label || 'untitled' }}</span>
        <span class="badge" *ngIf="!rec.compiledGesture">draft</span>
        <button class="play-btn" *ngIf="rec.compiledGesture"
                (click)="$event.stopPropagation(); preview(rec.compiledGesture!.id)"
                title="Preview gesture">▶</button>
      </div>

      <!-- Import -->
      <div style="margin-top:14px">
        <label class="import-btn" title="Import a .gesture.json file">
          📥 Import JSON
          <input type="file" accept=".json" style="display:none" (change)="onImport($event)" />
        </label>
      </div>
    </div>
  `,
    styles: [`
    .list-wrap { display:flex; flex-direction:column; overflow-y:auto; gap:2px; padding-right:2px; }
    .group-head { font-size:10.5px; font-weight:700; color:#8B5CF6; text-transform:uppercase; letter-spacing:.8px; margin-bottom:4px; }
    .item {
      display:flex; align-items:center; gap:8px; padding:7px 10px;
      border-radius:8px; cursor:pointer; border:1px solid transparent;
      transition: background .12s;
    }
    .item:hover { background:rgba(255,255,255,.05); }
    .item.sel { background:rgba(139,92,246,.14); border-color:rgba(139,92,246,.3); }
    .item.uncompiled { opacity:.7; }
    .dot { width:8px; height:8px; border-radius:50%; flex:none; }
    .dot.builtin { background:#60a5fa; }
    .dot.custom { background:#34d399; }
    .dot.draft { background:#f59e0b; }
    .name { flex:1; font-size:12.5px; color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .badge { font-size:9.5px; color:#f59e0b; border:1px solid #f59e0b44; border-radius:4px; padding:1px 5px; }
    .play-btn {
      flex:none; width:24px; height:24px; border-radius:6px; border:none;
      background:rgba(139,92,246,.18); color:#c4b0f7; cursor:pointer; font-size:10px;
      display:grid; place-items:center; opacity:.55; transition:opacity .12s;
    }
    .item:hover .play-btn, .item.sel .play-btn { opacity:1; }
    .play-btn:hover { background:rgba(139,92,246,.4); }
    .empty { font-size:11.5px; color:#55607a; padding:6px 2px; }
    .import-btn {
      font-size:12px; color:#99a; cursor:pointer; padding:7px 10px;
      border:1px dashed rgba(255,255,255,.12); border-radius:8px; display:block;
      text-align:center; transition:border-color .15s;
    }
    .import-btn:hover { border-color:rgba(255,255,255,.25); color:#ccc; }
  `]
})
export class GestureListComponent {
    @Output() builtinSelected = new EventEmitter<GestureDef>();
    @Output() customSelected = new EventEmitter<MotionRecording>();

    readonly store = inject(MotionStoreService);
    private registry = inject(CustomGestureRegistryService);
    private player = inject(GesturePlayerService);

    readonly builtins = GESTURE_LIBRARY;
    selectedId: string | null = null;

    selectBuiltin(def: GestureDef): void {
        this.selectedId = def.id;
        this.builtinSelected.emit(def);
    }

    selectCustom(rec: MotionRecording): void {
        this.selectedId = rec.id;
        this.customSelected.emit(rec);
    }

    preview(id: string): void {
        this.player.trigger(id);
    }

    onImport(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const json = reader.result as string;
            const rec = this.store.importJson(json);
            if (rec) {
                await this.store.save(rec);
                if (rec.compiledGesture) {
                    this.registry.register(rec.compiledGesture);
                }
                this.customSelected.emit(rec);
                this.selectedId = rec.id;
            }
        };
        reader.readAsText(file);
        // Reset so the same file can be re-imported
        input.value = '';
    }
}
