package expo.modules.androidspeech

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal interface AndroidAudioSession {
  val id: String
  val lifetime: CompletableJob
  val allowsBackgroundRecording: Boolean
  fun setAppForeground(foreground: Boolean)
  suspend fun start()
  suspend fun stop(): Map<String, Any>
  suspend fun cancel()
}

/** The sole owner of microphone capture, WAV finalization and audio-file transfer for all engines. */
internal class AndroidAudioCaptureSession(
  override val id: String,
  private val context: Context,
  override val lifetime: CompletableJob,
  override val allowsBackgroundRecording: Boolean = false,
  private val emitPcmToJs: Boolean = false,
  private val durationLimitMs: Long? = null,
  private val onPcm: (ByteArray) -> Unit = {},
  private val onCaptureFinished: () -> Unit = {},
  private val onInterrupt: () -> Unit = {},
  private val onDispose: () -> Unit = {},
  private val onVisibilityChanged: (Boolean) -> Unit = {},
  private val emit: (Map<String, Any>) -> Unit
) : AndroidAudioSession {
  private data class Failure(val code: String, val message: String) {
    fun toMap() = mapOf("code" to code, "message" to message)
  }

  val scope = CoroutineScope(lifetime + Dispatchers.IO)
  private val lifecycle = Mutex()
  private val failureLock = Any()
  private val microphoneLock = Any()
  private var failure: Failure? = null
  private val stopRequested = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  private val captureStarted = AtomicBoolean(false)
  private val foreground = AtomicBoolean(true)
  private val visibilityVersion = AtomicLong(0L)
  private var previewVisibilityVersion = 0L
  private var foregroundLease: MicrophoneForegroundLease? = null
  private val frameCount = AtomicLong(0L)
  private val record = AtomicReference<AudioRecord?>(null)
  private val captureReady = CompletableDeferred<Unit>()
  private val previewBytes = ByteArrayOutputStream(PCM_EVENT_BYTES)
  private var previewSequence = 0L
  private var previewFrameOffset = 0L
  private var file = File.createTempFile("live-speech-", ".wav", context.cacheDir)
  private var startTask: Deferred<Unit>? = null
  private var captureJob: Job? = null
  private var closed = false
  private var audioTransferred = false

  val isStopping: Boolean get() = stopRequested.get()
  val isCancelled: Boolean get() = cancelled.get()
  val hasFailure: Boolean get() = synchronized(failureLock) { failure != null }
  val isAppForeground: Boolean get() = foreground.get()
  val hasStartedCapture: Boolean get() = captureStarted.get()

  override fun setAppForeground(foreground: Boolean) {
    if (this.foreground.getAndSet(foreground) == foreground) return
    visibilityVersion.incrementAndGet()
    onVisibilityChanged(foreground)
  }

  override suspend fun start() = startPrepared {}

  suspend fun startPrepared(prepare: suspend () -> Unit) {
    if (closed || cancelled.get()) throw error("STALE_SESSION", "This recording session has already ended.")
    val task = scope.async<Unit> {
      if (!foreground.get()) throw error("BACKGROUND_START", "Open OpenWhispr before starting a recording.")
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw error("PERMISSION", "Allow microphone access to record audio.")
      }
      if (allowsBackgroundRecording) {
        if (!foreground.get()) throw error("BACKGROUND_START", "Open OpenWhispr before starting a background recording.")
        foregroundLease = MicrophoneForegroundLease.acquire(context, id) {
          fail("BACKGROUND_SERVICE_STOPPED", "Background recording was interrupted. Your captured audio can be saved.")
          stopRequested.set(true)
          stopMicrophone()
        }
      }
      prepare()
      currentCoroutineContext().ensureActive()
      synchronized(failureLock) { failure }?.let { throw error(it.code, it.message) }
      val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minimum <= 0) throw error("MICROPHONE_UNAVAILABLE", "This microphone cannot record the required audio format.")
      val recorder = AudioRecord.Builder()
        .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
        .setAudioFormat(AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(RATE)
          .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
          .build())
        .setBufferSizeInBytes(maxOf(minimum, RATE / 5 * 2))
        .build()
      record.set(recorder)
      currentCoroutineContext().ensureActive()
      if (recorder.state != AudioRecord.STATE_INITIALIZED) {
        throw error("MICROPHONE_UNAVAILABLE", "The microphone could not be initialized.")
      }
      synchronized(microphoneLock) {
        if (cancelled.get() || !lifetime.isActive) throw CancellationException("Recording was cancelled before microphone start.")
        if (stopRequested.get() || hasFailure || (allowsBackgroundRecording && foregroundLease?.isActive() != true)) {
          throw error("BACKGROUND_SERVICE_STOPPED", "Recording could not start because its audio service stopped.")
        }
        recorder.startRecording()
        if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
          throw error("MICROPHONE_UNAVAILABLE", "The microphone did not start recording.")
        }
        captureStarted.set(true)
      }
      captureJob = scope.launch { captureAudio(recorder) }
      captureReady.await()
      durationLimitMs?.let { limit ->
        scope.launch {
          delay(limit)
          fail("DURATION_LIMIT", "Recording reached its duration limit. Stop and save this recording.")
          stopRequested.set(true)
          stopMicrophone()
        }
      }
    }
    startTask = task
    task.await()
  }

  private suspend fun captureAudio(recorder: AudioRecord) {
    try {
      RandomAccessFile(file, "rw").use { output ->
        output.write(ByteArray(44))
        captureReady.complete(Unit)
        val samples = ShortArray(FRAMES)
        var levelCounter = 0
        try {
          while (!stopRequested.get()) {
            currentCoroutineContext().ensureActive()
            val count = recorder.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
            if (count <= 0) {
              if (stopRequested.get() || cancelled.get()) break
              throw error("MICROPHONE_READ", "The microphone stopped providing audio.")
            }
            val bytes = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
            var energy = 0.0
            repeat(count) { index ->
              val sample = samples[index]
              bytes.putShort(sample)
              energy += sample.toDouble() * sample
            }
            output.write(bytes.array())
            val totalFrames = frameCount.addAndGet(count.toLong())
            val version = visibilityVersion.get()
            if (emitPcmToJs && version != previewVisibilityVersion) {
              previewVisibilityVersion = version
              previewBytes.reset()
              previewFrameOffset = totalFrames - count
              if (foreground.get()) send(mapOf("type" to "preview-reset"))
            }
            if (!hasFailure && foreground.get()) {
              onPcm(bytes.array())
              if (emitPcmToJs) {
                previewBytes.write(bytes.array())
                if (previewBytes.size() >= PCM_EVENT_BYTES) flushPcmEvent()
              }
            }
            if (levelCounter++ % 5 == 0) {
              send(mapOf("type" to "level", "level" to (sqrt(energy / count) / 32768).coerceIn(0.0, 1.0)))
            }
          }
        } finally {
          writeWaveHeader(output, frameCount.get() * 2)
        }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      captureReady.completeExceptionally(error)
      fail("MICROPHONE_READ", error.message ?: "The audio recording was interrupted.")
    } finally {
      if (!captureReady.isCompleted) captureReady.completeExceptionally(error("MICROPHONE_READ", "The recording did not start."))
      if (!cancelled.get() && emitPcmToJs) flushPcmEvent()
      runCatching { onCaptureFinished() }
      releaseMicrophone()
      // Native completion must release foreground resources even when JS is suspended.
      runCatching { foregroundLease?.close() }
    }
  }

  private fun flushPcmEvent() {
    if (previewBytes.size() == 0) return
    val bytes = previewBytes.toByteArray()
    previewBytes.reset()
    send(mapOf(
      "type" to "audio",
      "pcmBase64" to Base64.encodeToString(bytes, Base64.NO_WRAP),
      "sequence" to previewSequence++,
      "frameOffset" to previewFrameOffset
    ))
    previewFrameOffset += bytes.size / 2
  }

  fun fail(code: String, message: String) {
    if (cancelled.get()) return
    val first = synchronized(failureLock) {
      if (failure == null) { failure = Failure(code, message); true } else false
    }
    if (first) send(mapOf("type" to "error", "code" to code, "message" to message))
  }

  fun send(event: Map<String, Any>) {
    if ((event["type"] == "audio" || event["type"] == "level") && !foreground.get()) return
    if (!cancelled.get()) runCatching { emit(event + ("sessionId" to id)) }
  }

  override suspend fun stop(): Map<String, Any> = stopPrepared()

  suspend fun stopPrepared(
    drain: suspend () -> Unit = {},
    fields: () -> Map<String, Any> = { emptyMap() }
  ): Map<String, Any> = withContext(NonCancellable) {
    lifecycle.withLock {
      if (closed) throw error("STALE_SESSION", "This recording session has already ended.")
      try {
        startTask?.await()
        stopRequested.set(true)
        stopMicrophone()
        try {
          withTimeout(3_000L) { captureJob?.join() }
        } catch (_: TimeoutCancellationException) {
          fail("CAPTURE_TIMEOUT", "The microphone did not stop cleanly. Your audio may be incomplete.")
          captureJob?.cancel()
          releaseMicrophone()
        }
        drain()
        if (frameCount.get() == 0L) fail("NO_AUDIO", "No audio was recorded.")
        cleanup(deleteAudio = false)
        adoptAudioForRetry()
        val result = mutableMapOf<String, Any>(
          "fileUri" to Uri.fromFile(file).toString(),
          "durationMs" to frameCount.get() * 1_000 / RATE
        )
        result.putAll(fields())
        synchronized(failureLock) { failure }?.let { result["error"] = it.toMap() }
        audioTransferred = true
        result
      } catch (error: Throwable) {
        cleanup(deleteAudio = true)
        throw error
      }
    }
  }

  override suspend fun cancel() = withContext(NonCancellable) {
    cancelled.set(true)
    stopRequested.set(true)
    stopMicrophone()
    lifetime.cancel()
    lifecycle.withLock {
      if (!closed) cleanup(deleteAudio = true)
      else if (!audioTransferred) file.delete()
    }
  }

  private suspend fun cleanup(deleteAudio: Boolean) {
    stopRequested.set(true)
    stopMicrophone()
    lifetime.cancel()
    runCatching { onInterrupt() }
    releaseMicrophone()
    try {
      withTimeout(3_000L) { lifetime.join() }
    } catch (_: TimeoutCancellationException) {
      // Platform reads are interrupted by release; retain a failure if finalization did not finish.
    } finally {
      releaseMicrophone()
      runCatching { onDispose() }
      runCatching { foregroundLease?.close() }
      foregroundLease = null
      if (deleteAudio) file.delete()
      closed = true
    }
  }

  private fun adoptAudioForRetry() {
    try {
      check(captureJob?.isCompleted != false) { "The recording has not finished finalizing." }
      check(file.isFile && file.length() == 44 + frameCount.get() * 2) { "The recording file is incomplete." }
      val riff = file.inputStream().use { input -> ByteArray(4).also { input.read(it) } }
      check(String(riff, Charsets.US_ASCII) == "RIFF") { "The recording header is incomplete." }
      val directory = File(context.cacheDir, "transcript-audio")
      check(directory.isDirectory || directory.mkdirs()) { "Retry audio storage could not be created." }
      val adopted = File(directory, file.name)
      check(!adopted.exists() && file.renameTo(adopted)) { "The recording could not be moved into retry audio storage." }
      file = adopted
    } catch (_: Exception) {
      val retainedFailure = synchronized(failureLock) {
        val previous = failure?.message
        Failure("AUDIO_RETENTION", "The recording could not be prepared for retry. The original audio was preserved." +
          if (previous == null) "" else " $previous").also { failure = it }
      }
      send(mapOf("type" to "error", "code" to retainedFailure.code, "message" to retainedFailure.message))
    }
  }

  private fun stopMicrophone() = synchronized(microphoneLock) {
    record.get()?.let { recorder ->
      runCatching { if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop() }
    }
    Unit
  }

  private fun releaseMicrophone() = synchronized(microphoneLock) {
    record.getAndSet(null)?.let { recorder ->
      runCatching { if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop() }
      runCatching { recorder.release() }
    }
    Unit
  }

  private fun writeWaveHeader(output: RandomAccessFile, bytes: Long) {
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray(Charsets.US_ASCII)); putInt((bytes + 36).toInt())
      put("WAVEfmt ".toByteArray(Charsets.US_ASCII)); putInt(16)
      putShort(1); putShort(1); putInt(RATE); putInt(RATE * 2); putShort(2); putShort(16)
      put("data".toByteArray(Charsets.US_ASCII)); putInt(bytes.toInt())
    }
    output.seek(0)
    output.write(header.array())
  }

  private fun error(code: String, message: String) = CodedException("ERR_ANDROID_SPEECH_$code", message, null)

  companion object {
    private const val RATE = 16_000
    private const val FRAMES = 320
    private const val PCM_EVENT_BYTES = 3_840 //120 ms at PCM16 mono/16 kHz.
  }
}
