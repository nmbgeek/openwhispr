package expo.modules.androidspeech

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.common.audio.AudioSource
import com.google.mlkit.genai.speechrecognition.SpeechRecognizer
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerRequest
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import expo.modules.kotlin.exception.CodedException
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
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** One microphone capture supplies both the recognizer and a recoverable PCM16 WAV file. */
internal class AndroidLiveSpeechSession(
  val id: String,
  private val context: Context,
  private val recognizer: SpeechRecognizer,
  val lifetime: CompletableJob,
  private val emit: (Map<String, Any>) -> Unit
) {
  private data class Failure(val code: String, val message: String) {
    fun toMap() = mapOf("code" to code, "message" to message)
  }

  private val scope = CoroutineScope(lifetime + Dispatchers.IO)
  private val lifecycle = Mutex()
  private val textLock = Any()
  private val microphoneLock = Any()
  private val committed = mutableListOf<String>()
  private var failure: Failure? = null
  private val stopRequested = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  private val recognitionFailed = AtomicBoolean(false)
  private val completed = AtomicBoolean(false)
  private val pipeDrained = AtomicBoolean(false)
  private val frameCount = AtomicLong(0L)
  private val record = AtomicReference<AudioRecord?>(null)
  private val captureReady = CompletableDeferred<Unit>()
  private val collectorReady = CompletableDeferred<Unit>()
  private val packets = Channel<ByteArray>(50) // At most one second of queued PCM.
  private var file = File.createTempFile("live-speech-", ".wav", context.cacheDir)
  private var pipe: Array<ParcelFileDescriptor>? = null
  private var source: AudioSource? = null
  private var startTask: Deferred<Unit>? = null
  private var captureJob: Job? = null
  private var pumpJob: Job? = null
  private var recognitionJob: Job? = null
  private var closed = false
  private var audioTransferred = false

  suspend fun start() {
    val task = scope.async<Unit> {
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        throw error("PERMISSION", "Allow microphone access to use live speech recognition.")
      }
      val status = withTimeout(15_000L) { recognizer.checkStatus() }
      if (status != FeatureStatus.AVAILABLE) {
        throw error("MODEL_NOT_READY", "Download the selected speech model before recording.")
      }
      currentCoroutineContext().ensureActive()
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
      val descriptors = ParcelFileDescriptor.createPipe()
      pipe = descriptors
      val flags = Os.fcntlInt(descriptors[1].fileDescriptor, OsConstants.F_GETFL, 0)
      Os.fcntlInt(descriptors[1].fileDescriptor, OsConstants.F_SETFL, flags or OsConstants.O_NONBLOCK)
      val audioSource = AudioSource.fromPfd(descriptors[0], AudioSource.Mode.STREAMING)
      source = audioSource
      val request = SpeechRecognizerRequest.Builder().apply { this.audioSource = audioSource }.build()
      recognitionJob = scope.launch { collectRecognition(request) }
      collectorReady.await()
      currentCoroutineContext().ensureActive()
      synchronized(textLock) { failure }?.let { throw error(it.code, it.message) }
      pumpJob = scope.launch { pumpAudio(descriptors[1]) }
      synchronized(microphoneLock) {
        if (cancelled.get() || !lifetime.isActive) throw CancellationException("Recording was cancelled before microphone start.")
        recorder.startRecording()
        if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
          throw error("MICROPHONE_UNAVAILABLE", "The microphone did not start recording.")
        }
      }
      captureJob = scope.launch { captureAudio(recorder) }
      captureReady.await()
      scope.launch {
        delay(30 * 60_000L)
        markError("DURATION_LIMIT", "Live recognition reached its 30-minute limit. Stop and save this recording.")
        stopRequested.set(true)
        stopMicrophone()
      }
    }
    startTask = task
    task.await()
  }

  private suspend fun collectRecognition(request: SpeechRecognizerRequest) {
    try {
      recognizer.startRecognition(request).onStart {
        collectorReady.complete(Unit)
      }.takeWhile { response ->
        if (response is SpeechRecognizerResponse.CompletedResponse) completed.set(true)
        !completed.get()
      }.collect { response ->
        when (response) {
          is SpeechRecognizerResponse.PartialTextResponse -> emitTranscript(response.text, false)
          is SpeechRecognizerResponse.FinalTextResponse -> emitTranscript(response.text, true)
          is SpeechRecognizerResponse.ErrorResponse -> throw response.e
          else -> Unit
        }
      }
      if (!stopRequested.get() || !pipeDrained.get()) {
        markError("INCOMPLETE", "Speech recognition ended before the recording was stopped. Your audio can still be saved.")
      }
    } catch (error: CancellationException) {
      if (!stopRequested.get() && !cancelled.get()) markError("CANCELLED", "Live speech recognition was interrupted.")
      throw error
    } catch (error: Exception) {
      collectorReady.completeExceptionally(error)
      if (error is GenAiException && error.message?.contains("NO_SPEECH_DETECTED", ignoreCase = true) == true) {
        markError("ERR_ANDROID_SPEECH_NO_SPEECH", "No speech detected. Please try speaking closer to the microphone.")
      } else {
        markError(
          if (error is GenAiException) "MLKIT_${error.errorCode}" else "RECOGNITION_FAILED",
          error.message ?: "Live speech recognition failed. Your audio can still be saved."
        )
      }
    } finally {
      if (!collectorReady.isCompleted) {
        collectorReady.completeExceptionally(error("RECOGNITION_FAILED", "Speech recognition did not start."))
      }
    }
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
            frameCount.addAndGet(count.toLong())
            if (!recognitionFailed.get() && !packets.trySend(bytes.array()).isSuccess) {
              markError("BACKPRESSURE", "Speech recognition could not keep up. Your full audio is still being saved.")
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
      markError("MICROPHONE_READ", error.message ?: "The audio recording was interrupted.")
    } finally {
      if (!captureReady.isCompleted) captureReady.completeExceptionally(error("MICROPHONE_READ", "The recording did not start."))
      packets.close()
      releaseMicrophone()
    }
  }

  private suspend fun pumpAudio(destination: ParcelFileDescriptor) {
    try {
      for (bytes in packets) {
        if (recognitionFailed.get()) break
        var offset = 0
        while (offset < bytes.size) {
          currentCoroutineContext().ensureActive()
          if (recognitionFailed.get()) return
          try {
            offset += Os.write(destination.fileDescriptor, bytes, offset, bytes.size - offset)
          } catch (error: ErrnoException) {
            if (error.errno != OsConstants.EAGAIN) throw error
            delay(5)
          }
        }
      }
      if (!recognitionFailed.get()) pipeDrained.set(true)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      markError("AUDIO_STREAM", error.message ?: "The speech service stopped reading audio.")
    } finally {
      runCatching { destination.close() }
    }
  }

  private fun emitTranscript(fragment: String, final: Boolean) {
    if (cancelled.get() || recognitionFailed.get()) return
    val snapshot = synchronized(textLock) {
      if (final && fragment.isNotBlank()) committed.add(fragment.trim())
      (committed + if (final || fragment.isBlank()) emptyList() else listOf(fragment.trim())).joinToString(" ")
    }
    send(mapOf("type" to "transcript", "text" to snapshot, "isFinal" to final))
  }

  private fun markError(code: String, message: String) {
    if (cancelled.get()) return
    recognitionFailed.set(true)
    val first = synchronized(textLock) {
      if (failure == null) {
        failure = Failure(code, message)
        true
      } else false
    }
    if (first) send(mapOf("type" to "error", "code" to code, "message" to message))
  }

  private fun send(event: Map<String, Any>) {
    if (!cancelled.get()) runCatching { emit(event + ("sessionId" to id)) }
  }

  suspend fun stop(): Map<String, Any> = withContext(NonCancellable) {
    lifecycle.withLock {
      if (closed) throw error("STALE_SESSION", "This recording session has already ended.")
      try {
        startTask?.await()
        stopRequested.set(true)
        stopMicrophone()
        try {
          withTimeout(3_000L) { captureJob?.join() }
        } catch (_: TimeoutCancellationException) {
          markError("CAPTURE_TIMEOUT", "The microphone did not stop cleanly. Your audio may be incomplete.")
          captureJob?.cancel()
          releaseMicrophone()
        }
        if (!recognitionFailed.get()) {
          try {
            withTimeout(3_000L) { pumpJob?.join() }
            withTimeout(3_000L) { recognizer.stopRecognition() }
            withTimeout(8_000L) { recognitionJob?.join() }
          } catch (_: TimeoutCancellationException) {
            markError("DRAIN_TIMEOUT", "Speech recognition did not finish. Your recording can be retried.")
          }
        }
        if (!completed.get() && !recognitionFailed.get()) {
          markError("INCOMPLETE", "Speech recognition ended without a final result. Your recording can be retried.")
        }
        if (frameCount.get() == 0L) markError("NO_AUDIO", "No audio was recorded.")
        cleanup(deleteAudio = false)
        adoptAudioForRetry()
        val result = mutableMapOf<String, Any>(
          "text" to synchronized(textLock) { committed.joinToString(" ") },
          "fileUri" to Uri.fromFile(file).toString(),
          "durationMs" to frameCount.get() * 1_000 / RATE
        )
        synchronized(textLock) { failure }?.let { result["error"] = it.toMap() }
        audioTransferred = true
        result
      } catch (error: Throwable) {
        cleanup(deleteAudio = true)
        throw error
      }
    }
  }

  suspend fun cancel() = withContext(NonCancellable) {
    cancelled.set(true)
    stopRequested.set(true)
    stopMicrophone()
    // Cancelling the lifetime also invalidates a pending start before it can open the mic.
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
    packets.cancel()
    pipe?.forEach { runCatching { it.close() } }
    releaseMicrophone() // Also interrupts a platform read that has not returned after stop().
    try {
      withTimeout(3_000L) { lifetime.join() }
    } catch (_: TimeoutCancellationException) {
      // Native reads/writes are bounded or nonblocking; release is a final interruption path.
    } finally {
      releaseMicrophone()
      runCatching { recognizer.close() }
      runCatching { source?.close() }
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
      // Preserve the original cache file and make the failed handoff explicit to JavaScript.
      recognitionFailed.set(true)
      val retainedFailure = synchronized(textLock) {
        val previous = failure?.message
        Failure(
          "AUDIO_RETENTION",
          "The recording could not be prepared for retry. The original audio was preserved." +
            if (previous == null) "" else " $previous"
        ).also { failure = it }
      }
      send(mapOf("type" to "error", "code" to retainedFailure.code, "message" to retainedFailure.message))
    }
  }

  private fun stopMicrophone() {
    synchronized(microphoneLock) {
      record.get()?.let { recorder ->
        runCatching { if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop() }
      }
    }
  }

  private fun releaseMicrophone() {
    synchronized(microphoneLock) {
      record.getAndSet(null)?.let { recorder ->
        runCatching { if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop() }
        runCatching { recorder.release() }
      }
    }
  }

  private fun writeWaveHeader(output: RandomAccessFile, bytes: Long) {
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray(Charsets.US_ASCII))
      putInt((bytes + 36).toInt())
      put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
      putInt(16)
      putShort(1)
      putShort(1)
      putInt(RATE)
      putInt(RATE * 2)
      putShort(2)
      putShort(16)
      put("data".toByteArray(Charsets.US_ASCII))
      putInt(bytes.toInt())
    }
    output.seek(0)
    output.write(header.array())
  }

  private fun error(code: String, message: String) = CodedException("ERR_ANDROID_SPEECH_$code", message, null)

  companion object {
    private const val RATE = 16_000
    private const val FRAMES = 320
  }
}
