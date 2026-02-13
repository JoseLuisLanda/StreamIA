import { Injectable, inject } from '@angular/core';
import { AvatarOption, ImageCollection, Scene } from './live.models';
import { IndexedDBService } from './indexed-db.service';

@Injectable({
    providedIn: 'root'
})
export class LiveStorageService {
    private readonly AVATAR_SETTINGS_KEY = 'avatarSettings';
    private readonly CUSTOM_AVATARS_KEY = 'customAvatars';
    private readonly HIDDEN_AVATARS_KEY = 'hiddenAvatarIds';
    private readonly USER_EMAIL_KEY = 'userEmail';
    private indexedDB = inject(IndexedDBService);

    constructor() {
        // Initialize IndexedDB on service creation
        this.indexedDB.initDB().catch(err => {
            console.error('Failed to initialize IndexedDB:', err);
        });
    }

    async saveCollections(collections: ImageCollection[]): Promise<void> {
        try {
            const existingCollections = await this.indexedDB.getAllCollections();
            const nextCollectionIds = new Set(collections.map(collection => collection.id));

            for (const existing of existingCollections) {
                if (existing?.id && !nextCollectionIds.has(existing.id)) {
                    await this.indexedDB.deleteCollection(existing.id);
                }
            }

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

    async saveCustomAvatars(avatars: AvatarOption[]): Promise<void> {
        try {
            const customAvatars = avatars
                .filter(avatar => avatar.isCustom)
                .map(avatar => ({
                    id: avatar.id,
                    name: avatar.name,
                    url: avatar.url,
                    thumbnail: avatar.thumbnail,
                    defaultCollectionId: avatar.defaultCollectionId,
                    isCustom: true,
                    storagePath: avatar.storagePath,
                    ownerEmail: avatar.ownerEmail,
                    sourceUrl: avatar.sourceUrl
                }));

            await this.indexedDB.saveSetting(this.CUSTOM_AVATARS_KEY, customAvatars);
        } catch (e) {
            console.error('❌ Could not save custom avatars:', e);
        }
    }

    async loadCustomAvatars(): Promise<AvatarOption[]> {
        try {
            const customAvatars = await this.indexedDB.getSetting(this.CUSTOM_AVATARS_KEY);
            if (!Array.isArray(customAvatars)) {
                return [];
            }

            return customAvatars
                .filter(avatar => typeof avatar?.url === 'string' && typeof avatar?.id === 'string')
                .map((avatar: AvatarOption) => ({
                    ...avatar,
                    isCustom: true
                }));
        } catch (e) {
            console.error('❌ Could not load custom avatars:', e);
            return [];
        }
    }

    async saveHiddenAvatarIds(avatarIds: string[]): Promise<void> {
        try {
            await this.indexedDB.saveSetting(this.HIDDEN_AVATARS_KEY, avatarIds);
        } catch (e) {
            console.error('❌ Could not save hidden avatar ids:', e);
        }
    }

    async loadHiddenAvatarIds(): Promise<string[]> {
        try {
            const avatarIds = await this.indexedDB.getSetting(this.HIDDEN_AVATARS_KEY);
            if (!Array.isArray(avatarIds)) {
                return [];
            }

            return avatarIds.filter(id => typeof id === 'string');
        } catch (e) {
            console.error('❌ Could not load hidden avatar ids:', e);
            return [];
        }
    }

    async saveUserEmail(email: string): Promise<void> {
        try {
            await this.indexedDB.saveSetting(this.USER_EMAIL_KEY, email);
        } catch (e) {
            console.error('❌ Could not save user email:', e);
        }
    }

    async loadUserEmail(): Promise<string | null> {
        try {
            const email = await this.indexedDB.getSetting(this.USER_EMAIL_KEY);
            return typeof email === 'string' && email.trim() ? email : null;
        } catch (e) {
            console.error('❌ Could not load user email:', e);
            return null;
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

    async saveAvatarSettings(avatars: AvatarOption[]): Promise<void> {
        try {
            const settings = avatars.map(a => ({
                id: a.id,
                defaultCollectionId: a.defaultCollectionId
            }));

            await this.indexedDB.saveSetting(this.AVATAR_SETTINGS_KEY, settings);
        } catch (e) {
            console.warn('Could not save avatar settings to IndexedDB:', e);
        }
    }

    async loadAvatarSettings(avatars: AvatarOption[]): Promise<void> {
        try {
            let settings = await this.indexedDB.getSetting(this.AVATAR_SETTINGS_KEY);

            if (!Array.isArray(settings)) {
                const legacy = localStorage.getItem(this.AVATAR_SETTINGS_KEY);
                if (legacy) {
                    settings = JSON.parse(legacy);
                    if (Array.isArray(settings)) {
                        await this.indexedDB.saveSetting(this.AVATAR_SETTINGS_KEY, settings);
                        localStorage.removeItem(this.AVATAR_SETTINGS_KEY);
                    }
                }
            }

            if (Array.isArray(settings)) {
                settings.forEach((setting: { id: string; defaultCollectionId?: string }) => {
                    const avatar = avatars.find(a => a.id === setting.id);
                    if (avatar) {
                        avatar.defaultCollectionId = setting.defaultCollectionId;
                    }
                });
            }
        } catch (e) {
            console.warn('Could not load avatar settings from IndexedDB:', e);
        }
    }
}
