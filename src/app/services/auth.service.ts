import { Injectable, signal } from '@angular/core';
import {
  GoogleAuthProvider,
  User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut
} from 'firebase/auth';
import { getFirebaseAuth } from './firebase-client';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  readonly user = signal<User | null>(null);
  readonly isReady = signal(false);
  readonly initError = signal<string | null>(null);

  constructor() {
    try {
      const auth = getFirebaseAuth();
      onAuthStateChanged(auth, (user) => {
        this.user.set(user);
        this.isReady.set(true);
      });
    } catch (error) {
      this.initError.set(error instanceof Error ? error.message : 'Firebase Auth is not configured.');
      this.isReady.set(true);
    }
  }

  get isAuthenticated(): boolean {
    return this.user() !== null;
  }

  async waitUntilReady(): Promise<void> {
    if (this.isReady()) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (this.isReady()) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
  }

  async signInWithEmail(email: string, password: string): Promise<void> {
    if (this.initError()) {
      throw new Error(this.initError()!);
    }
    await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
  }

  async signUpWithEmail(email: string, password: string): Promise<void> {
    if (this.initError()) {
      throw new Error(this.initError()!);
    }
    await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
  }

  async signInWithGoogle(): Promise<void> {
    if (this.initError()) {
      throw new Error(this.initError()!);
    }
    const provider = new GoogleAuthProvider();
    await signInWithPopup(getFirebaseAuth(), provider);
  }

  async logout(): Promise<void> {
    if (this.initError()) {
      return;
    }
    await signOut(getFirebaseAuth());
  }
}
