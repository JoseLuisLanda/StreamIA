import { Component, OnInit, inject, ChangeDetectorRef, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ModelCacheService, ModelInfo } from '../../services/model-cache.service';

@Component({
  selector: 'app-ar-viewer',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './ar-viewer.html',
  styleUrl: './ar-viewer.css',
  schemas: [CUSTOM_ELEMENTS_SCHEMA]
})
export class ArViewer implements OnInit {
  private modelCache = inject(ModelCacheService);
  private cdr = inject(ChangeDetectorRef);
  
  models: ModelInfo[] = [];
  isLoadingModels: boolean = true;
  currentModelUrl: string = '';
  currentModelName: string = '';
  isPanelCollapsed: boolean = false;

  ngOnInit(): void {
    this.loadModelsFromStorage();
  }

  async loadModelsFromStorage(): Promise<void> {
    try {
      this.isLoadingModels = true;
      this.cdr.detectChanges();
      console.log('📦 Loading models from Firebase Storage...');
      this.models = await this.modelCache.listModelsFromStorage();
      console.log(`✅ Loaded ${this.models.length} models`, this.models);
      
      // Cargar el primer modelo por defecto
      if (this.models.length > 0) {
        await this.selectModel(this.models[0]);
      }
    } catch (error) {
      console.error('Error loading models from storage:', error);
    } finally {
      this.isLoadingModels = false;
      this.cdr.detectChanges();
    }
  }

  async selectModel(model: ModelInfo): Promise<void> {
    try {
      console.log('📱 Selecting model for AR:', model.storagePath);
      
      // Obtener la URL de descarga directa desde Firebase Storage
      this.currentModelUrl = await this.modelCache.getDownloadUrl(model.storagePath);
      this.currentModelName = model.displayName;
      
      console.log('✅ Model URL ready for AR:', this.currentModelUrl);
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Error selecting model:', error);
    }
  }

  togglePanel(): void {
    this.isPanelCollapsed = !this.isPanelCollapsed;
  }
}
