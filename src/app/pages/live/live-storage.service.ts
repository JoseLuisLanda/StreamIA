import { Injectable, inject } from '@angular/core';
import { AvatarOption, ImageCollection, Scene } from './live.models';
import { IndexedDBService } from './indexed-db.service';

@Injectable({
    providedIn: 'root'
})
export class LiveStorageService {
    private readonly AVATAR_SETTINGS_KEY = 'avatarSettings';
    private indexedDB = inject(IndexedDBService);

    constructor() {
        // Initialize IndexedDB on service creation
        this.indexedDB.initDB().catch(err => {
            console.error('Failed to initialize IndexedDB:', err);
        });
    }

    async saveCollections(collections: ImageCollection[]): Promise<void> {
        try {
            // Save each collection individually
            for (const collection of collections) {
                await this.indexedDB.saveCollection(collection);
            }
        } catch (e) {
            console.error('❌ Could not save collections to IndexedDB:', e);
        }
    }

    async loadCollections(): Promise<ImageCollection[]> {
        try {
            const collections = await this.indexedDB.getAllCollections();
            return collections;
        } catch (e) {
            console.error('❌ Could not load collections from IndexedDB:', e);
            return [];
        }
    }

    async deleteCollection(collectionId: string): Promise<void> {
        try {
            await this.indexedDB.deleteCollection(collectionId);
        } catch (e) {
            console.error('❌ Could not delete collection from IndexedDB:', e);
        }
    }

    async saveScenes(scenes: Scene[]): Promise<void> {
        try {
            // Save each scene individually
            for (const scene of scenes) {
                await this.indexedDB.saveScene(scene);
            }
        } catch (e) {
            console.error('❌ Could not save scenes to IndexedDB:', e);
        }
    }

    async loadScenes(): Promise<Scene[]> {
        try {
            const scenes = await this.indexedDB.getAllScenes();
            return scenes;
        } catch (e) {
            console.error('❌ Could not load scenes from IndexedDB:', e);
            return [];
        }
    }

    async deleteScene(sceneId: string): Promise<void> {
        try {
            await this.indexedDB.deleteScene(sceneId);
        } catch (e) {
            console.error('❌ Could not delete scene from IndexedDB:', e);
        }
    }

    // Avatar settings still use localStorage (small data)
    saveAvatarSettings(avatars: AvatarOption[]): void {
        try {
            const settings = avatars.map(a => ({
                id: a.id,
                defaultCollectionId: a.defaultCollectionId
            }));
            localStorage.setItem(this.AVATAR_SETTINGS_KEY, JSON.stringify(settings));
        } catch (e) {
            console.warn('Could not save avatar settings:', e);
        }
    }

    loadAvatarSettings(avatars: AvatarOption[]): void {
        try {
            const saved = localStorage.getItem(this.AVATAR_SETTINGS_KEY);
            if (saved) {
                const settings = JSON.parse(saved);
                settings.forEach((setting: { id: string; defaultCollectionId?: string }) => {
                    const avatar = avatars.find(a => a.id === setting.id);
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
