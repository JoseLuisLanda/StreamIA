import { Component, OnDestroy, OnInit, ViewChild, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

// Core Components
import { AvatarViewerComponent } from '../../components/avatar-viewer/avatar-viewer.component';
import { VideoPreviewComponent } from '../../components/video-preview/video-preview.component';
import { MediaOverlayComponent, MediaOverlay, MediaItem } from '../../components/media-overlay/media-overlay.component';

// Subcomponents
import { SceneManagerComponent } from './components/scene-manager.component';
import { AvatarSelectorComponent, CustomAvatarRequest } from './components/avatar-selector.component';
import { MediaOverlayManagerComponent } from './components/media-overlay-manager.component';
import { BackgroundManagerComponent } from './components/background-manager.component';

// Models & Services
import { AvatarOption, ImageCollection, AvatarSize, Scene } from './live.models';
import { LiveStorageService } from './live-storage.service';
import { ModelCacheService } from '../../services/model-cache.service';
import { FirebaseAvatarStorageService } from '../../services/firebase-avatar-storage.service';

@Component({
  selector: 'app-live',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    AvatarViewerComponent,
    VideoPreviewComponent,
    MediaOverlayComponent,
    SceneManagerComponent,
    AvatarSelectorComponent,
    MediaOverlayManagerComponent,
    BackgroundManagerComponent
  ],
  templateUrl: './live.component.html',
  styleUrls: ['./live.component.css']
})
export class LiveComponent implements OnInit, OnDestroy {
  @ViewChild('avatarViewer') avatarViewer!: AvatarViewerComponent;

  private storageService = inject(LiveStorageService);
  private modelCache = inject(ModelCacheService);
  private firebaseAvatarStorage = inject(FirebaseAvatarStorageService);
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);

  // Constants / Config
  private readonly defaultAvatars: AvatarOption[] = [
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

  avatars: AvatarOption[] = [...this.defaultAvatars];

  sizeOptions = [
    { label: 'S', value: 'small' as AvatarSize },
    { label: 'M', value: 'medium' as AvatarSize },
    { label: 'L', value: 'large' as AvatarSize }
  ];

  positionOptions = [
    { label: '⬅️', value: 'left' as const },
    { label: '⏺️', value: 'center' as const },
    { label: '➡️', value: 'right' as const }
  ];

  // State
  avatarPosition: 'left' | 'center' | 'right' = 'center';
  currentAvatar: AvatarOption | null = null;
  currentAvatarUrl = this.defaultAvatars[0]?.url || '';
  isPanelOpen = false;
  avatarSize: AvatarSize = 'medium';

  collections: ImageCollection[] = [];
  activeCollection: ImageCollection | null = null;

  mediaOverlays: MediaOverlay[] = [];
  selectedOverlayId: string | null = null; // Track selected overlay for individual sizing
  isFreeMoveMode = false;

  currentBackgroundIndex = 0;
  currentBackground: string | null = null;
  carouselMode: 'manual' | 'auto' = 'auto';
  autoIntervalSeconds = 5;
  private autoChangeInterval: any = null;

  scenes: Scene[] = [];
  currentSceneId: string | null = null;
  isSceneLoading = false;

  // Accordion State
  activeSections: Set<string> = new Set([]);

  // Orientation State
  currentOrientation: 'landscape' | 'portrait' = 'landscape';
  private hiddenAvatarIds = new Set<string>();

  get filteredScenes() {
    return this.scenes.filter(s => !s.orientation || s.orientation === 'any' || s.orientation === this.currentOrientation);
  }

  checkOrientation() {
    this.currentOrientation = window.innerWidth < window.innerHeight ? 'portrait' : 'landscape';

    if (this.currentOrientation === 'portrait') {
      // Enforce portrait constraints
      if (this.avatarPosition !== 'center') {
        this.setAvatarPosition('center');
      }
      this.isFreeMoveMode = false;

      // Enforce Max 1 Screen logic
      if (this.mediaOverlays.length > 1) {
        // Keep only the last one or first one? Let's keep the first.
        this.mediaOverlays = this.mediaOverlays.slice(0, 1);
      }

      // Ensure the single overlay is selected so sidebar controls (Share Screen) appear
      if (this.mediaOverlays.length > 0) {
        // Don't overwrite if already selected to avoid flicker, but ensure non-null
        if (this.selectedOverlayId !== this.mediaOverlays[0].id) {
          this.selectOverlay(this.mediaOverlays[0].id);
        }
      }
    }
  }

  toggleSection(section: string) {
    if (this.activeSections.has(section)) {
      this.activeSections.delete(section);
    } else {
      this.activeSections.add(section);
    }
  }

  async ngOnInit() {
    this.checkOrientation();
    window.addEventListener('resize', () => {
      this.checkOrientation();
    });

    const [collections, scenes, savedCustomAvatars, hiddenAvatarIds] = await Promise.all([
      this.storageService.loadCollections(),
      this.storageService.loadScenes(),
      this.storageService.loadCustomAvatars(),
      this.storageService.loadHiddenAvatarIds()
    ]);

    this.collections = collections;
    this.scenes = scenes;
    this.hiddenAvatarIds = new Set(hiddenAvatarIds);
    this.avatars = [...this.defaultAvatars, ...this.getUniqueCustomAvatars(savedCustomAvatars)]
      .filter(avatar => !this.hiddenAvatarIds.has(avatar.id));
    await this.storageService.loadAvatarSettings(this.avatars);

    // Force change detection after loading
    this.cdr.detectChanges();

    // Now select the avatar after everything is loaded
    if (this.avatars.length > 0) {
      this.selectAvatar(this.avatars[0]);
    }
  }

  ngOnDestroy() {
    this.stopAutoChange();
  }

  // --- UI Layout ---
  togglePanel() {
    this.isPanelOpen = !this.isPanelOpen;
    setTimeout(() => {
      if (this.avatarViewer) {
        this.avatarViewer.forceResize();
      }
    }, 350);
  }

  // --- Avatar Logic ---
  selectAvatar(avatar: AvatarOption) {
    this.currentAvatar = avatar;
    this.currentAvatarUrl = avatar.url;

    if (avatar.defaultCollectionId) {
      const collection = this.collections.find(c => c.id === avatar.defaultCollectionId);
      if (collection) {
        this.selectCollection(collection);
      } else {
        avatar.defaultCollectionId = undefined;
        void this.storageService.saveAvatarSettings(this.avatars);
        this.clearActiveCollection();
      }
    } else {
      this.clearActiveCollection();
    }
  }

  setAvatarSize(size: AvatarSize) {
    this.avatarSize = size;
  }

  setAvatarPosition(pos: 'left' | 'center' | 'right') {
    this.avatarPosition = pos;
  }

  onAvatarCollectionChange() {
    void this.storageService.saveAvatarSettings(this.avatars);
    void this.storageService.saveCustomAvatars(this.avatars);
    if (this.currentAvatar?.defaultCollectionId) {
      const collection = this.collections.find(c => c.id === this.currentAvatar!.defaultCollectionId);
      if (collection) {
        this.selectCollection(collection);
      }
    }
  }

  async loadCustomAvatar(request: CustomAvatarRequest) {
    if (!request?.url || !request.url.trim()) {
      return;
    }

    try {
      const avatarName = this.resolveAvatarName(request.name);
      if (!avatarName) {
        alert('Avatar name is required.');
        return;
      }

      const email = await this.resolveUserEmail();
      if (!email) {
        alert('Necesitas iniciar sesión para guardar el avatar en Firebase Storage.');
        return;
      }

      const normalizedUrl = this.normalizeAvatarUrl(request.url);
      const expectedStoragePath = this.firebaseAvatarStorage.buildAvatarPath(email, avatarName);
      const customAvatarId = this.createAvatarIdFromUrl(expectedStoragePath);

      if (this.hiddenAvatarIds.has(customAvatarId)) {
        this.hiddenAvatarIds.delete(customAvatarId);
        await this.storageService.saveHiddenAvatarIds(Array.from(this.hiddenAvatarIds));
      }

      const avatarBuffer = await this.preloadAvatarModel(normalizedUrl);
      const uploadResult = await this.firebaseAvatarStorage.uploadAvatar(email, avatarName, avatarBuffer);

      let customAvatar = this.avatars.find(avatar => avatar.storagePath === uploadResult.path);

      if (!customAvatar) {
        customAvatar = this.createCustomAvatar(normalizedUrl, avatarName, email, uploadResult.path, normalizedUrl);
        this.avatars = [...this.avatars, customAvatar];
      } else {
        customAvatar.id = this.createAvatarIdFromUrl(uploadResult.path);
        customAvatar.name = avatarName;
        customAvatar.url = normalizedUrl;
        customAvatar.storagePath = uploadResult.path;
        customAvatar.ownerEmail = email;
        customAvatar.sourceUrl = normalizedUrl;
      }

      this.selectAvatar(customAvatar);
      await this.storageService.saveCustomAvatars(this.avatars);
      await this.storageService.saveAvatarSettings(this.avatars);
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Error loading custom avatar:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      alert('Error loading custom avatar: ' + message);
    }
  }

  async deleteAvatar(avatar: AvatarOption) {
    if (this.avatars.length <= 1) {
      alert('At least one avatar must remain available.');
      return;
    }

    if (!confirm(`Delete avatar "${avatar.name}"?`)) {
      return;
    }

    if (avatar.storagePath) {
      try {
        await this.firebaseAvatarStorage.deleteAvatar(avatar.storagePath);
      } catch (error) {
        console.error('Error deleting avatar from Firebase Storage:', error);
        alert('Could not delete avatar from Firebase Storage. Try again.');
        return;
      }
    }

    this.avatars = this.avatars.filter(item => item.id !== avatar.id);
    this.hiddenAvatarIds.add(avatar.id);

    await this.storageService.saveHiddenAvatarIds(Array.from(this.hiddenAvatarIds));
    await this.storageService.saveCustomAvatars(this.avatars);
    await this.storageService.saveAvatarSettings(this.avatars);

    if (this.currentAvatar?.id === avatar.id) {
      const nextAvatar = this.avatars[0] ?? null;
      if (nextAvatar) {
        this.selectAvatar(nextAvatar);
      } else {
        this.currentAvatar = null;
        this.currentAvatarUrl = '';
        this.clearActiveCollection();
      }
    }

    this.cdr.detectChanges();
  }

  // --- Media Overlays Logic ---
  addOverlay(name?: string) {
    const newOverlay: MediaOverlay = {
      id: Date.now().toString(),
      name: name || `Screen ${this.mediaOverlays.length + 1}`,
      items: [],
      currentIndex: 0,
      isPlaying: false,
      autoLoop: true,
      intervalSeconds: 3,
      width: 320,
      height: 240, // 4:3 aspect ratio for horizontal
      layout: 'horizontal'
    };
    this.mediaOverlays.push(newOverlay);
    this.selectedOverlayId = newOverlay.id; // Auto-select the new overlay
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

  selectOverlay(id: string) {
    this.selectedOverlayId = id;
  }

  resizeOverlay(event: { overlayId: string, size: number }) {
    const overlay = this.mediaOverlays.find(o => o.id === event.overlayId);
    if (overlay) {
      overlay.width = event.size;
      // Calculate height based on layout aspect ratio
      if (overlay.layout === 'horizontal') {
        overlay.height = Math.round(event.size * 3 / 4); // 4:3 ratio
      } else if (overlay.layout === 'square') {
        overlay.height = event.size; // 1:1 ratio
      } else {
        overlay.height = Math.round(event.size * 4 / 3); // 3:4 ratio
      }
    }
  }

  changeOverlayLayout(event: { overlayId: string, layout: 'horizontal' | 'vertical' | 'square' }) {
    const overlay = this.mediaOverlays.find(o => o.id === event.overlayId);
    if (overlay) {
      overlay.layout = event.layout;
      // Recalculate height based on new layout
      if (overlay.layout === 'horizontal') {
        overlay.height = Math.round(overlay.width * 3 / 4); // 4:3 ratio
      } else if (overlay.layout === 'square') {
        overlay.height = overlay.width; // 1:1 ratio
      } else {
        overlay.height = Math.round(overlay.width * 4 / 3); // 3:4 ratio
      }
    }
  }

  assignCollectionToOverlay(overlay: MediaOverlay, collectionId: string) {
    const collection = this.collections.find(c => c.id === collectionId);
    if (collection) {
      overlay.items = collection.images.map(url => {
        const isVideo = url.startsWith('data:video') || url.endsWith('.mp4') || url.endsWith('.webm');
        return {
          type: isVideo ? 'video' : 'image',
          url: url
        };
      });
      overlay.name = collection.name;
      overlay.currentIndex = 0;
    }
  }

  async captureScreen(overlay: MediaOverlay) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const streamItem: MediaItem = { type: 'stream', stream };
      overlay.items = [streamItem];
      overlay.name = 'Live Capture';
      overlay.currentIndex = 0;
      overlay.isPlaying = true;
      this.updateOverlay(overlay);
    } catch (err) {
      console.error('Error starting screen share:', err);
    }
  }

  toggleFreeMoveMode() {
    this.isFreeMoveMode = !this.isFreeMoveMode;

    if (this.isFreeMoveMode && this.mediaOverlays.length > 0) {
      this.mediaOverlays.forEach((overlay, index) => {
        if (!overlay.position) {
          const totalWidth = this.mediaOverlays.reduce((sum, o) => sum + o.width + 20, -20);
          const startX = (window.innerWidth - totalWidth) / 2;
          let currentX = startX;
          this.mediaOverlays.forEach((o, i) => {
            if (i < index) {
              currentX += o.width + 20;
            }
          });
          overlay.position = { x: currentX, y: 50 };
        }
      });
    }
  }

  // --- Background Logic ---
  onFilesSelected(data: { event: Event, name: string }) {
    const input = data.event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const collectionName = data.name.trim() || `Collection ${this.collections.length + 1}`;
    const newCollection: ImageCollection = {
      id: Date.now().toString(),
      name: collectionName,
      images: []
    };

    const filesArray = Array.from(input.files);
    let loadedCount = 0;

    filesArray.forEach(file => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target?.result as string;
        newCollection.images.push(dataUrl);
        loadedCount++;

        if (loadedCount === filesArray.length) {
          // Create a new array reference to trigger change detection
          this.collections = [...this.collections, newCollection];
          await this.storageService.saveCollections(this.collections);

          // Force change detection
          this.cdr.detectChanges();

          this.selectCollection(newCollection);
        }
      };
      reader.readAsDataURL(file);
    });
    input.value = '';
  }

  selectCollection(collection: ImageCollection) {
    this.stopAutoChange(); // Stop any existing interval first
    this.activeCollection = collection;
    this.currentBackgroundIndex = 0;
    this.updateCurrentBackground();

    // Start auto-change if in auto mode and has multiple images
    if (this.carouselMode === 'auto' && collection.images.length > 1) {
      this.startAutoChange();
    }
  }

  async deleteCollection(collection: ImageCollection) {
    const index = this.collections.findIndex(c => c.id === collection.id);
    if (index !== -1) {
      // Create a new array reference to trigger change detection
      this.collections = this.collections.filter(c => c.id !== collection.id);
      await this.storageService.saveCollections(this.collections);
      await this.storageService.deleteCollection(collection.id);

      this.avatars.forEach(avatar => {
        if (avatar.defaultCollectionId === collection.id) {
          avatar.defaultCollectionId = undefined;
        }
      });
      await this.storageService.saveAvatarSettings(this.avatars);
      await this.storageService.saveCustomAvatars(this.avatars);

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

    // Force change detection to update the view
    this.cdr.detectChanges();
  }

  onModeChange() {
    this.stopAutoChange(); // Always stop first
    if (this.carouselMode === 'auto' && this.activeCollection && this.activeCollection.images.length > 1) {
      this.startAutoChange();
    }
  }

  onIntervalChange() {
    // Only restart if we're in auto mode with an active collection
    if (this.carouselMode === 'auto' && this.activeCollection && this.activeCollection.images.length > 1) {
      this.startAutoChange(); // startAutoChange already calls stopAutoChange
    }
  }

  private startAutoChange() {
    this.stopAutoChange();
    if (!this.activeCollection || this.activeCollection.images.length <= 1) {
      return;
    }

    // Run interval inside Angular zone to ensure change detection
    this.ngZone.run(() => {
      this.autoChangeInterval = setInterval(() => {
        this.ngZone.run(() => {
          this.nextBackground();
        });
      }, this.autoIntervalSeconds * 1000);
    });
  }

  private stopAutoChange() {
    if (this.autoChangeInterval) {
      clearInterval(this.autoChangeInterval);
      this.autoChangeInterval = null;
    }
  }

  // --- Scenes Logic ---
  saveCurrentScene() {
    const sceneName = prompt('Name this scene:', `Scene ${this.scenes.length + 1}`);
    if (!sceneName) return;

    const overlaysClone = this.mediaOverlays.map(o => ({
      ...o,
      items: o.items.filter(i => i.type !== 'stream'),
      position: o.position
    }));

    const newScene: Scene = {
      id: Date.now().toString(),
      name: sceneName,
      orientation: this.currentOrientation,
      config: {
        avatarId: this.currentAvatar?.id,
        avatarSize: this.avatarSize,
        avatarPosition: this.avatarPosition,
        backgroundCollectionId: this.activeCollection?.id,
        overlays: JSON.parse(JSON.stringify(overlaysClone)),
        isFreeMoveMode: this.isFreeMoveMode
      }
    };

    this.scenes.push(newScene);
    this.currentSceneId = newScene.id;
    this.storageService.saveScenes(this.scenes);
  }

  updateCurrentScene() {
    if (!this.currentSceneId) return;

    const sceneIndex = this.scenes.findIndex(s => s.id === this.currentSceneId);
    if (sceneIndex === -1) return;

    if (!confirm(`Update scene "${this.scenes[sceneIndex].name}" with current layout?`)) return;

    const overlaysClone = this.mediaOverlays.map(o => ({
      ...o,
      items: o.items.filter(i => i.type !== 'stream'),
      position: o.position
    }));

    this.scenes[sceneIndex].config = {
      avatarId: this.currentAvatar?.id,
      avatarSize: this.avatarSize,
      avatarPosition: this.avatarPosition,
      backgroundCollectionId: this.activeCollection?.id,
      overlays: JSON.parse(JSON.stringify(overlaysClone)),
      isFreeMoveMode: this.isFreeMoveMode
    };

    this.storageService.saveScenes(this.scenes);
  }

  loadScene(scene: Scene) {
    console.log('🎬 Loading scene:', scene.name);
    this.currentSceneId = scene.id;

    // 1. Start hiding avatar immediately
    this.isSceneLoading = true;
    this.cdr.detectChanges(); // Force update to start fade out

    // 2. Wait for fade out to complete (300ms) before changing anything
    setTimeout(() => {
      console.log('  Avatar hidden, applying changes...');
      console.log('  Avatar ID:', scene.config.avatarId);
      console.log('  Avatar Size:', scene.config.avatarSize);
      console.log('  Avatar Position:', scene.config.avatarPosition);

      let isChangingAvatar = false;

      // 3. Apply changes while hidden
      // First, select the avatar if specified
      if (scene.config.avatarId) {
        const avatar = this.avatars.find(a => a.id === scene.config.avatarId);
        if (avatar && avatar !== this.currentAvatar) {
          console.log('  Selecting avatar:', avatar.name);
          isChangingAvatar = true;
          this.selectAvatar(avatar);
        }
      }

      // Then set avatar size and position
      this.avatarSize = scene.config.avatarSize;
      this.avatarPosition = scene.config.avatarPosition;

      this.cdr.detectChanges(); // Apply changes to components

      // 4. Force transform update and show avatar
      // Use longer delay if loading new avatar to ensure it's ready
      const updateDelay = isChangingAvatar ? 1200 : 100;
      console.log('  Will show avatar in', updateDelay, 'ms');

      setTimeout(() => {
        if (this.avatarViewer && (this.avatarViewer as any).updateModelTransform) {
          console.log('  Forcing avatar transform update');
          (this.avatarViewer as any).updateModelTransform();
        }

        // Show avatar again after update
        this.isSceneLoading = false;
        this.cdr.detectChanges();
      }, updateDelay);

      // Load background collection
      if (scene.config.backgroundCollectionId) {
        const collection = this.collections.find(c => c.id === scene.config.backgroundCollectionId);
        if (collection) {
          this.selectCollection(collection);
        }
      } else {
        this.clearActiveCollection();
      }

      // Load media overlays
      this.mediaOverlays = JSON.parse(JSON.stringify(scene.config.overlays));

      // Restore free move mode state
      this.isFreeMoveMode = scene.config.isFreeMoveMode || false;

      console.log('✅ Scene loaded successfully');
    }, 300); // Wait 300ms for fade out transition
  }

  async deleteScene(sceneId: string) {
    if (confirm('Delete this scene?')) {
      this.scenes = this.scenes.filter(s => s.id !== sceneId);
      await this.storageService.saveScenes(this.scenes);
      await this.storageService.deleteScene(sceneId);
    }
  }

  private getUniqueCustomAvatars(savedCustomAvatars: AvatarOption[]): AvatarOption[] {
    const usedUrls = new Set(this.defaultAvatars.map(avatar => avatar.url));
    const uniqueCustomAvatars: AvatarOption[] = [];

    for (const avatar of savedCustomAvatars) {
      const preferredUrl = avatar.sourceUrl || avatar.url;
      const normalizedUrl = this.normalizeAvatarUrl(preferredUrl);
      if (usedUrls.has(normalizedUrl)) {
        continue;
      }

      uniqueCustomAvatars.push({
        ...avatar,
        id: avatar.id || this.createAvatarIdFromUrl(avatar.storagePath || avatar.sourceUrl || normalizedUrl),
        name: avatar.name || `Custom ${uniqueCustomAvatars.length + 1}`,
        url: normalizedUrl,
        thumbnail: avatar.thumbnail || this.buildAvatarThumbnail(normalizedUrl),
        isCustom: true
      });
      usedUrls.add(normalizedUrl);
    }

    return uniqueCustomAvatars;
  }

  private async resolveUserEmail(): Promise<string | null> {
    const firebaseEmail = this.firebaseAvatarStorage.getAuthenticatedEmail();
    if (firebaseEmail) {
      await this.storageService.saveUserEmail(firebaseEmail);
      return firebaseEmail;
    }
    return null;
  }

  private resolveAvatarName(name: string): string | null {
    const trimmedName = name?.trim();
    if (trimmedName) {
      return trimmedName;
    }

    const promptedName = prompt('Name for the avatar:', '');
    const normalizedName = promptedName?.trim() ?? '';
    return normalizedName || null;
  }

  private async preloadAvatarModel(url: string): Promise<ArrayBuffer> {
    if (this.avatarViewer) {
      await this.avatarViewer.preloadAvatar(url);
    }

    const cachedData = await this.modelCache.getCachedModel(url);
    if (cachedData) {
      return cachedData;
    }

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    await this.modelCache.cacheModel(url, arrayBuffer);
    return arrayBuffer;
  }

  private createCustomAvatar(url: string, name: string, ownerEmail: string, storagePath: string, sourceUrl: string): AvatarOption {
    const customCount = this.avatars.filter(avatar => avatar.isCustom).length + 1;

    return {
      id: this.createAvatarIdFromUrl(storagePath),
      name: name || `Custom ${customCount}`,
      url,
      thumbnail: this.buildAvatarThumbnail(url),
      isCustom: true,
      storagePath,
      ownerEmail,
      sourceUrl
    };
  }

  private createAvatarIdFromUrl(url: string): string {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash) + url.charCodeAt(i);
      hash |= 0;
    }
    return `custom-${Math.abs(hash)}`;
  }

  private buildAvatarThumbnail(url: string): string {
    const baseUrl = url.split('?')[0];
    if (baseUrl.toLowerCase().endsWith('.glb')) {
      return `${baseUrl.slice(0, -4)}.png`;
    }
    return baseUrl;
  }

  private normalizeAvatarUrl(url: string): string {
    let normalizedUrl = url.trim();

    if (!/\.glb(\?|$)/i.test(normalizedUrl)) {
      const queryStart = normalizedUrl.indexOf('?');
      if (queryStart >= 0) {
        const base = normalizedUrl.slice(0, queryStart);
        const query = normalizedUrl.slice(queryStart);
        normalizedUrl = `${base}.glb${query}`;
      } else {
        normalizedUrl = `${normalizedUrl}.glb`;
      }
    }

    if (!normalizedUrl.includes('morphTargets')) {
      normalizedUrl += (normalizedUrl.includes('?') ? '&' : '?') + 'morphTargets=ARKit&textureAtlas=1024';
    }

    return normalizedUrl;
  }
}
