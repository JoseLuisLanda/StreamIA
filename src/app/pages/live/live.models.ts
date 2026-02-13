import { MediaOverlay } from '../../components/media-overlay/media-overlay.component';

export interface AvatarOption {
    id: string;
    name: string;
    url: string;
    thumbnail: string;
    defaultCollectionId?: string;
    isCustom?: boolean;
    storagePath?: string;
    ownerEmail?: string;
    sourceUrl?: string;
}

export interface ImageCollection {
    id: string;
    name: string;
    images: string[];
}

export type AvatarSize = 'small' | 'medium' | 'large';

export interface SceneConfig {
    avatarId?: string;
    avatarSize: AvatarSize;
    avatarPosition: 'left' | 'center' | 'right';
    backgroundCollectionId?: string;
    overlays: MediaOverlay[];
    isFreeMoveMode: boolean;
}

export interface Scene {
    id: string;
    name: string;
    config: SceneConfig;
    orientation?: 'landscape' | 'portrait' | 'any';
}
