/** Formats the transcription API accepts, in order of preference. Safari records mp4 only. */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function pickMimeType(isSupported: (type: string) => boolean): string | undefined {
  return MIME_CANDIDATES.find((t) => isSupported(t));
}

export const canRecord = () =>
  typeof MediaRecorder !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';

export interface Recording {
  /** Finish and get the audio. */
  stop(): Promise<Blob>;
  /** Throw the audio away. */
  cancel(): void;
}

/**
 * Record from the microphone. `onLevel` gets the input loudness (0 to 1) every frame, for a meter.
 * Rejects with the browser's DOMException when access is denied or there's no microphone.
 */
export async function startRecording(onLevel: (level: number) => void): Promise<Recording> {
  // Voice processing off: on phones it puts audio in call mode, and ending that plays a
  // hang-up tone. Nothing plays while recording, so there's no echo to cancel.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  // Loudness meter.
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  audio.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    // Speech RMS sits around 0.02-0.2; stretch that across the meter.
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
    frame = requestAnimationFrame(tick);
  };
  tick();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    cancelAnimationFrame(frame);
    for (const track of stream.getTracks()) track.stop();
    void audio.close();
  };

  recorder.start(1000);
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        const finish = () => {
          release();
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
        };
        // Already stopped (the mic was unplugged, say): no stop event will come.
        if (recorder.state === 'inactive') return finish();
        recorder.onstop = finish;
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
