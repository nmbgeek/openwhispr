import { Buffer } from 'buffer';
import type { TranscriptionResponse } from '@/types';
import { LocalWhisperService } from './LocalWhisperService';

// Native capture is mono PCM16 at 16 kHz. Draft previews cover only the recent
// tail; the full retained WAV is authoritative and is transcribed once on Stop.
const BYTES_PER_SECOND = 16000 * 2;
const WINDOW_BYTES = 8 * BYTES_PER_SECOND;
const MIN_PREVIEW_BYTES = BYTES_PER_SECOND;
const PREVIEW_INTERVAL_MS = 1250;
const MAX_BASE64_LENGTH = Math.ceil(WINDOW_BYTES / 3) * 4;

type Options = { language?: string; prompt?: string };
type Callbacks = { onText: (text: string) => void; onError?: (error: Error) => void };

function abortError(): Error {
  return Object.assign(new Error('Live Whisper was cancelled.'), { name: 'AbortError' });
}

export class WhisperLivePreview {
  private readonly tail = new Uint8Array(WINDOW_BYTES);
  private writeAt = 0;
  private byteLength = 0;
  private dirty = false;
  private closed = false;
  private cancelled = false;
  private paused = false;
  private nextPreviewAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private previewAbort: AbortController | null = null;
  private readonly finalAbort = new AbortController();
  private finalResult: Promise<TranscriptionResponse & { provider: 'local' }> | null = null;

  private constructor(
    private readonly options: Options,
    private readonly callbacks: Callbacks,
  ) {}

  static async prepare(options: Options, callbacks: Callbacks): Promise<WhisperLivePreview> {
    if (!LocalWhisperService.isAvailable()) throw new Error('Whisper needs a native app build.');
    const models = await LocalWhisperService.getAvailableModels();
    if (!models.some((model) => model.name === 'base' && model.downloaded && model.path)) {
      throw new Error('Model "base" is not available. Please download it first from Settings.');
    }
    // 'auto' chooses multilingual base, never an English-only model left by an older install.
    await LocalWhisperService.prepareForLanguage('auto');
    return new WhisperLivePreview({ ...options, language: options.language ?? 'auto' }, callbacks);
  }

  pushPcm(pcmBase64: string): void {
    if (this.closed || this.paused || !pcmBase64) return;
    // Cap even an oversized event before decoding, then keep sample-aligned tail bytes.
    const padding = pcmBase64.endsWith('==') ? 2 : pcmBase64.endsWith('=') ? 1 : 0;
    const sourceBytes = (pcmBase64.length / 4) * 3 - padding;
    if (pcmBase64.length % 4 !== 0 || sourceBytes % 2 !== 0) {
      this.callbacks.onError?.(new Error('Live Whisper received an incomplete PCM16 sample.'));
      return;
    }
    const decoded = Buffer.from(pcmBase64.slice(-MAX_BASE64_LENGTH), 'base64');
    // Trimming Base64 groups may start on an odd byte. Align from the complete
    // source's sample-aligned end rather than treating that suffix as a new stream.
    const tailBytes = Math.min(WINDOW_BYTES, decoded.byteLength - (decoded.byteLength % 2));
    const pcm = decoded.subarray(decoded.byteLength - tailBytes);
    const first = Math.min(pcm.byteLength, WINDOW_BYTES - this.writeAt);
    this.tail.set(pcm.subarray(0, first), this.writeAt);
    this.tail.set(pcm.subarray(first), 0);
    this.writeAt = (this.writeAt + pcm.byteLength) % WINDOW_BYTES;
    this.byteLength = Math.min(WINDOW_BYTES, this.byteLength + pcm.byteLength);
    this.dirty = this.dirty || pcm.byteLength > 0;
    this.schedule();
  }

  /** Discard draft audio across background gaps; the native WAV remains complete. */
  pause(): void {
    if (this.closed || this.paused) return;
    this.paused = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.byteLength = 0;
    this.writeAt = 0;
    this.nextPreviewAt = 0;
    this.previewAbort?.abort();
  }

  resume(): void {
    if (this.closed || !this.paused) return;
    this.paused = false;
    this.schedule();
  }

  private schedule(): void {
    if (
      this.closed ||
      this.paused ||
      this.inFlight ||
      this.timer !== null ||
      !this.dirty ||
      this.byteLength < MIN_PREVIEW_BYTES
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.decodeTail();
      },
      Math.max(0, this.nextPreviewAt - Date.now()),
    );
  }

  private snapshot(): ArrayBuffer {
    // A dedicated exact-size ArrayBuffer avoids Buffer pool offsets and sharing
    // mutable ring memory with the native decoder.
    const copy = new Uint8Array(this.byteLength);
    const start = (this.writeAt - this.byteLength + WINDOW_BYTES) % WINDOW_BYTES;
    const first = Math.min(this.byteLength, WINDOW_BYTES - start);
    copy.set(this.tail.subarray(start, start + first));
    copy.set(this.tail.subarray(0, this.byteLength - first), first);
    return copy.buffer;
  }

  private decodeTail(): void {
    if (this.closed || this.paused || this.inFlight || !this.dirty) return;
    const pcm = this.snapshot();
    this.dirty = false;
    this.nextPreviewAt = Date.now() + PREVIEW_INTERVAL_MS;
    const abort = new AbortController();
    this.previewAbort = abort;
    const run = LocalWhisperService.transcribePcm(pcm, { ...this.options, signal: abort.signal })
      .then((text) => {
        if (!this.closed && !abort.signal.aborted && text) this.callbacks.onText(text);
      })
      .catch((error: unknown) => {
        // Preview errors do not discard captured speech; Stop still runs the complete WAV.
        if (!this.closed && !abort.signal.aborted) {
          this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      })
      .finally(() => {
        this.inFlight = null;
        if (this.previewAbort === abort) this.previewAbort = null;
        this.schedule();
      });
    this.inFlight = run;
  }

  private async stopPreviews(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.previewAbort?.abort();
    await this.inFlight;
  }

  finish(audioUri: string): Promise<TranscriptionResponse & { provider: 'local' }> {
    if (this.cancelled) return Promise.reject(abortError());
    if (this.finalResult) return this.finalResult;
    this.finalResult = (async () => {
      await this.stopPreviews();
      if (this.cancelled) throw abortError();
      const result = await LocalWhisperService.transcribe(audioUri, {
        ...this.options,
        modelName: 'base',
        signal: this.finalAbort.signal,
        pcm16Wav: true,
      });
      if (this.cancelled) throw abortError();
      return { ...result, provider: 'local', endpoint: 'whisper-base' };
    })();
    return this.finalResult;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.finalAbort.abort();
    await this.stopPreviews();
    await this.finalResult?.catch(() => undefined);
  }
}
