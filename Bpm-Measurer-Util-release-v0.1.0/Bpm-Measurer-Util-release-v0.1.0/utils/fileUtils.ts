import { extractPeaks } from './audioUtils';
import { TimingPoint, AudioData } from '../types';

// Browser version - uses File API
export const handleFileUpload = async (
  file: File,
  audioContext: AudioContext
): Promise<{ audioData: AudioData; fileName: string } | null> => {
  if (!file) return null;
  
  const arrayBuffer = await file.arrayBuffer();
  try {
    if (audioContext.state === 'suspended') await audioContext.resume();
    const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const peaks = extractPeaks(decodedBuffer);
    return {
      audioData: { buffer: decodedBuffer, peaks, duration: decodedBuffer.duration },
      fileName: file.name
    };
  } catch (err) {
    console.error('Audio decode error:', err);
    return null;
  }
};

// Electron version - uses IPC to get file path
export const handleElectronFileUpload = async (
  audioContext: AudioContext
): Promise<{ audioData: AudioData; fileName: string } | null> => {
  if ((window as any).electronAPI) {
    const filePath = await (window as any).electronAPI.openAudioFile();
    if (!filePath) return null;
    
    const fs = (window as any).require('fs');
    const arrayBuffer = fs.readFileSync(filePath).buffer;
    
    try {
      if (audioContext.state === 'suspended') await audioContext.resume();
      const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const peaks = extractPeaks(decodedBuffer);
      return {
        audioData: { buffer: decodedBuffer, peaks, duration: decodedBuffer.duration },
        fileName: filePath.split(/[\\/]/).pop() || 'unknown'
      };
    } catch (err) {
      console.error('Audio decode error:', err);
      return null;
    }
  }
  return null;
};
