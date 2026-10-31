export type Platform = 'instagram' | 'youtube' | 'facebook' | 'x';

export interface MediaFormat { quality: string; value: number; locked: boolean; size: number }
export interface MediaInfo {
  success: true;
  platform: Platform;
  title: string;
  thumbnail: string | null;
  freeMaxQuality: number;
  audioSize: number;
  mp3Size: number;
  formats: MediaFormat[];
}
export interface ApiErrorBody { success: false; message: string }
export type AudioFormat = 'mp3' | 'm4a';
