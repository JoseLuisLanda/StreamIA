import { Injectable } from '@angular/core';
import { getFirebaseStorageClient } from './firebase-client';
import { ref, listAll, getDownloadURL, getBlob } from 'firebase/storage';

interface ModelInfo {
    name: string;
    displayName: string;
    storagePath: string;
    downloadUrl?: string;
}

@Injectable({
    providedIn: 'root'
})
export class ModelCacheService {
    private dbName = 'AvatarModelsCache';
    private storeName = 'models';
    private db: IDBDatabase | null = null;
    private storage = getFirebaseStorageClient();

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

    /**
     * Lista todos los modelos disponibles en Firebase Storage desde la carpeta 3dmodels/examples
     */
    async listModelsFromStorage(): Promise<ModelInfo[]> {
        try {
            const storageRef = ref(this.storage, '3dmodels/examples');
            const result = await listAll(storageRef);
            
            const models: ModelInfo[] = [];
            
            for (const itemRef of result.items) {
                // Solo archivos .glb
                if (itemRef.name.toLowerCase().endsWith('.glb')) {
                    const displayName = this.formatDisplayName(itemRef.name);
                    models.push({
                        name: itemRef.name.replace('.glb', ''),
                        displayName: displayName,
                        storagePath: itemRef.fullPath
                    });
                }
            }
            
            console.log(`📦 Found ${models.length} models in Firebase Storage`);
            return models;
        } catch (error) {
            console.error('Error listing models from storage:', error);
            return [];
        }
    }

    /**
     * Formatea el nombre del archivo para mostrar
     */
    private formatDisplayName(fileName: string): string {
        // Remover extensión
        const nameWithoutExt = fileName.replace('.glb', '');
        
        // Capitalizar primera letra y reemplazar guiones/underscores con espacios
        const formatted = nameWithoutExt
            .replace(/[-_]/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
        
        // Agregar emoji según el nombre
        const emojis: { [key: string]: string } = {
            'glasses': '👓',
            'lentes': '👓',
            'hair': '💇',
            'cabello': '💇',
            'header': '👤',
            'cabeza': '👤',
            'mask': '🎭',
            'mascara': '🎭',
            'mustache': '🧔',
            'bigote': '🧔',
            'pineapple': '🍍',
            'piña': '🍍',
            'strawberry': '🍓',
            'fresa': '🍓',
            'shirt': '👕',
            'camisa': '👕',
            'playera': '👕',
            'tshirt': '👕',
            'plane': '✈️',
            'avion': '✈️',
            'imagen': '🖼️',
            'image': '🖼️',
            'menu': '📋'
        };
        
        const lowerName = nameWithoutExt.toLowerCase();
        for (const [key, emoji] of Object.entries(emojis)) {
            if (lowerName.includes(key)) {
                return `${emoji} ${formatted}`;
            }
        }
        
        return `📦 ${formatted}`;
    }

    /**
     * Descarga un modelo desde Firebase Storage y lo cachea localmente
     * Retorna una URL de blob para cargar con GLTFLoader
     */
    async getModelBlob(storagePath: string): Promise<string> {
        try {
            // Intentar obtener del cache primero
            const cached = await this.getCachedModel(storagePath);
            if (cached) {
                console.log('✅ Model found in cache:', storagePath);
                const blob = new Blob([cached], { type: 'model/gltf-binary' });
                return URL.createObjectURL(blob);
            }

            // Si no está en cache, obtener URL de descarga directa
            console.log('📥 Model not in cache, getting download URL:', storagePath);
            const storageRef = ref(this.storage, storagePath);
            const downloadUrl = await getDownloadURL(storageRef);
            
            console.log('🔗 Returning direct download URL (CORS-enabled)');
            
            // Retornar la URL de descarga directamente
            // GLTFLoader la descargará y nosotros cachearemos después
            return downloadUrl;
        } catch (error) {
            console.error('Error getting model blob:', error);
            throw error;
        }
    }

    /**
     * Cachea un modelo después de ser descargado por GLTFLoader
     */
    async cacheModelFromUrl(storagePath: string, downloadUrl: string): Promise<void> {
        try {
            console.log('💾 Caching model:', storagePath);
            
            // Descargar con fetch y credenciales necesarias
            const response = await fetch(downloadUrl, {
                mode: 'cors',
                credentials: 'same-origin'
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            await this.cacheModel(storagePath, arrayBuffer);
            
            console.log('✅ Model cached successfully');
        } catch (error) {
            console.warn('⚠️ Could not cache model (will work from URL):', error);
            // No lanzar error - el modelo ya se cargó desde la URL
        }
    }

    /**
     * Obtiene la URL de descarga directa de Firebase Storage (sin cache)
     */
    async getDownloadUrl(storagePath: string): Promise<string> {
        try {
            const storageRef = ref(this.storage, storagePath);
            return await getDownloadURL(storageRef);
        } catch (error) {
            console.error('Error getting download URL:', error);
            throw error;
        }
    }
}

export type { ModelInfo };
