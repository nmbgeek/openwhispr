package expo.modules.androidspeech

import android.content.Context
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
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** ML Kit consumer of the shared microphone/WAV owner. No second recorder exists here. */
internal class AndroidLiveSpeechSession(
  override val id: String,
  context: Context,
  private val recognizer: SpeechRecognizer,
  override val lifetime: CompletableJob,
  emit: (Map<String, Any>) -> Unit
) : AndroidAudioSession {
  private val textLock = Any()
  private val committed = mutableListOf<String>()
  private val completed = AtomicBoolean(false)
  private val pipeDrained = AtomicBoolean(false)
  private val collectorReady = CompletableDeferred<Unit>()
  private val packets = Channel<ByteArray>(50)
  private var pipe: Array<ParcelFileDescriptor>? = null
  private var source: AudioSource? = null
  private var pumpJob: Job? = null
  private var recognitionJob: Job? = null
  private val capture = AndroidAudioCaptureSession(
    id, context, lifetime,
    durationLimitMs = 30 * 60_000L,
    onPcm = ::acceptAudio,
    onCaptureFinished = { packets.close() },
    onInterrupt = ::interruptBackend,
    onDispose = ::disposeBackend,
    emit = emit
  )

  override suspend fun start() = capture.startPrepared {
    val status = withTimeout(15_000L) { recognizer.checkStatus() }
    if (status != FeatureStatus.AVAILABLE) {
      throw error("MODEL_NOT_READY", "Download the selected speech model before recording.")
    }
    val descriptors = ParcelFileDescriptor.createPipe()
    pipe = descriptors
    val flags = Os.fcntlInt(descriptors[1].fileDescriptor, OsConstants.F_GETFL, 0)
    Os.fcntlInt(descriptors[1].fileDescriptor, OsConstants.F_SETFL, flags or OsConstants.O_NONBLOCK)
    val audioSource = AudioSource.fromPfd(descriptors[0], AudioSource.Mode.STREAMING)
    source = audioSource
    val request = SpeechRecognizerRequest.Builder().apply { this.audioSource = audioSource }.build()
    recognitionJob = capture.scope.launch { collectRecognition(request) }
    collectorReady.await()
    pumpJob = capture.scope.launch { pumpAudio(descriptors[1]) }
  }

  private fun acceptAudio(bytes: ByteArray) {
    if (!capture.hasFailure && !packets.trySend(bytes).isSuccess) {
      capture.fail("BACKPRESSURE", "Speech recognition could not keep up. Your full audio is still being saved.")
    }
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
      if (!capture.isStopping || !pipeDrained.get()) {
        capture.fail("INCOMPLETE", "Speech recognition ended before the recording was stopped. Your audio can still be saved.")
      }
    } catch (error: CancellationException) {
      if (!capture.isStopping && !capture.isCancelled) capture.fail("CANCELLED", "Live speech recognition was interrupted.")
      throw error
    } catch (error: Exception) {
      collectorReady.completeExceptionally(error)
      if (error is GenAiException && error.message?.contains("NO_SPEECH_DETECTED", ignoreCase = true) == true) {
        capture.fail("ERR_ANDROID_SPEECH_NO_SPEECH", "No speech detected. Please try speaking closer to the microphone.")
      } else {
        capture.fail(
          if (error is GenAiException) "MLKIT_${error.errorCode}" else "RECOGNITION_FAILED",
          error.message ?: "Live speech recognition failed. Your audio can still be saved."
        )
      }
    } finally {
      if (!collectorReady.isCompleted) collectorReady.completeExceptionally(error("RECOGNITION_FAILED", "Speech recognition did not start."))
    }
  }

  private suspend fun pumpAudio(destination: ParcelFileDescriptor) {
    try {
      for (bytes in packets) {
        if (capture.hasFailure) break
        var offset = 0
        while (offset < bytes.size) {
          currentCoroutineContext().ensureActive()
          if (capture.hasFailure) return
          try {
            offset += Os.write(destination.fileDescriptor, bytes, offset, bytes.size - offset)
          } catch (error: ErrnoException) {
            if (error.errno != OsConstants.EAGAIN) throw error
            delay(5)
          }
        }
      }
      if (!capture.hasFailure) pipeDrained.set(true)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      capture.fail("AUDIO_STREAM", error.message ?: "The speech service stopped reading audio.")
    } finally {
      runCatching { destination.close() }
    }
  }

  private fun emitTranscript(fragment: String, final: Boolean) {
    if (capture.isCancelled || capture.hasFailure) return
    val snapshot = synchronized(textLock) {
      if (final && fragment.isNotBlank()) committed.add(fragment.trim())
      (committed + if (final || fragment.isBlank()) emptyList() else listOf(fragment.trim())).joinToString(" ")
    }
    capture.send(mapOf("type" to "transcript", "text" to snapshot, "isFinal" to final))
  }

  override suspend fun stop(): Map<String, Any> = capture.stopPrepared(
    drain = {
      if (!capture.hasFailure) {
        try {
          withTimeout(3_000L) { pumpJob?.join() }
          withTimeout(3_000L) { recognizer.stopRecognition() }
          withTimeout(8_000L) { recognitionJob?.join() }
        } catch (_: TimeoutCancellationException) {
          capture.fail("DRAIN_TIMEOUT", "Speech recognition did not finish. Your recording can be retried.")
        }
      }
      if (!completed.get() && !capture.hasFailure) {
        capture.fail("INCOMPLETE", "Speech recognition ended without a final result. Your recording can be retried.")
      }
    },
    fields = { mapOf("text" to synchronized(textLock) { committed.joinToString(" ") }) }
  )

  override suspend fun cancel() = capture.cancel()

  private fun interruptBackend() {
    packets.cancel()
    pipe?.forEach { runCatching { it.close() } }
  }

  private fun disposeBackend() {
    runCatching { recognizer.close() }
    runCatching { source?.close() }
  }

  private fun error(code: String, message: String) = CodedException("ERR_ANDROID_SPEECH_$code", message, null)
}
