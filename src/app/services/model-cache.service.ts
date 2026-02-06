import { Injectable } from '@angular/core';

@Injectable({
    providedIn: 'root'
})
export class ModelCacheService {
    private dbName = 'AvatarModelsCache';
    private storeName = 'models';
    private db: IDBDatabase | null = null;

    constructor() {
        this.initDB();
    }

    private async initDB(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'url' });
                }
            };
        });
    }

    private async ensureDB(): Promise<IDBDatabase> {
        if (!this.db) {
            await this.initDB();
        }
        return this.db!;
    }

    async getCachedModel(url: string): Promise<ArrayBuffer | null> {
        try {
            const db = await this.ensureDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.get(url);

                request.onsuccess = () => {
                    const result = request.result;
                    if (result && result.data) {
                        console.log('✅ Model loaded from cache:', url);
                        resolve(result.data);
                    } else {
                        resolve(null);
                    }
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('Error getting cached model:', error);
            return null;
        }
    }

    async cacheModel(url: string, data: ArrayBuffer): Promise<void> {
        try {
            const db = await this.ensureDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.put({ url, data, timestamp: Date.now() });

                request.onsuccess = () => {
                    console.log('💾 Model cached successfully:', url);
                    resolve();
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('Error caching model:', error);
        }
    }

    async clearCache(): Promise<void> {
        try {
            const db = await this.ensureDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.clear();

                request.onsuccess = () => {
                    console.log('🗑️ Model cache cleared');
                    resolve();
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('Error clearing cache:', error);
        }
    }

    async getCacheSize(): Promise<number> {
        try {
            const db = await this.ensureDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.getAll();

                request.onsuccess = () => {
                    const models = request.result;
                    const totalSize = models.reduce((sum, model) => {
                        return sum + (model.data?.byteLength || 0);
                    }, 0);
                    resolve(totalSize);
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('Error getting cache size:', error);
            return 0;
        }
    }
}
