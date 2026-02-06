import { Injectable } from '@angular/core';

@Injectable({
    providedIn: 'root'
})
export class IndexedDBService {
    private dbName = 'LiveAppDB';
    private dbVersion = 1;
    private db: IDBDatabase | null = null;

    async initDB(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                console.error('❌ IndexedDB failed to open:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event: any) => {
                const db = event.target.result;

                // Create object stores if they don't exist
                if (!db.objectStoreNames.contains('collections')) {
                    db.createObjectStore('collections', { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains('scenes')) {
                    db.createObjectStore('scenes', { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };
        });
    }

    async saveCollection(collection: any): Promise<void> {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['collections'], 'readwrite');
            const store = transaction.objectStore('collections');
            const request = store.put(collection);

            request.onsuccess = () => {
                resolve();
            };

            request.onerror = () => {
                console.error('❌ Failed to save collection:', request.error);
                reject(request.error);
            };
        });
    }

    async getAllCollections(): Promise<any[]> {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['collections'], 'readonly');
            const store = transaction.objectStore('collections');
            const request = store.getAll();

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => {
                console.error('❌ Failed to load collections:', request.error);
                reject(request.error);
            };
        });
    }

    async deleteCollection(id: string): Promise<void> {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['collections'], 'readwrite');
            const store = transaction.objectStore('collections');
            const request = store.delete(id);

            request.onsuccess = () => {
                resolve();
            };

            request.onerror = () => {
                console.error('❌ Failed to delete collection:', request.error);
                reject(request.error);
            };
        });
    }

    async saveScene(scene: any): Promise<void> {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['scenes'], 'readwrite');
            const store = transaction.objectStore('scenes');
            const request = store.put(scene);

            request.onsuccess = () => {
                resolve();
            };

            request.onerror = () => {
                console.error('❌ Failed to save scene:', request.error);
                reject(request.error);
            };
        });
    }

    async getAllScenes(): Promise<any[]> {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['scenes'], 'readonly');
            const store = transaction.objectStore('scenes');
            const request = store.getAll();

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => {
                console.error('❌ Failed to load scenes:', request.error);
                reject(request.error);
            };
        });
    }

    async deleteScene(id: string): Promise<void> {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['scenes'], 'readwrite');
            const store = transaction.objectStore('scenes');
            const request = store.delete(id);

            request.onsuccess = () => {
                resolve();
            };

            request.onerror = () => {
                console.error('❌ Failed to delete scene:', request.error);
                reject(request.error);
            };
        });
    }

    async saveSetting(key: string, value: any): Promise<void> {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');
            const request = store.put({ key, value });

            request.onsuccess = () => {
                resolve();
            };

            request.onerror = () => {
                console.error('❌ Failed to save setting:', request.error);
                reject(request.error);
            };
        });
    }

    async getSetting(key: string): Promise<any> {
        if (!this.db) await this.initDB();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const request = store.get(key);

            request.onsuccess = () => {
                resolve(request.result?.value);
            };

            request.onerror = () => {
                console.error('❌ Failed to load setting:', request.error);
                reject(request.error);
            };
        });
    }
}
