package expo.modules.androidspeech

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.common.audio.AudioSource
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizer
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerRequest
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.IllformedLocaleException
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

class AndroidSpeechModule : Module() {
  // Downloads and inference are explicitly exclusive. Status checks use independent clients,
  // so returning from settings cannot cancel or replace an in-flight transcription.
  private val activeOperation = AtomicReference<Job?>(null)
  private val liveSession = AtomicReference<AndroidLiveSpeechSession?>(null)
  private val cancelledSessionIds = ConcurrentHashMap.newKeySet<String>()
  private val cancelledSessionOrder = ConcurrentLinkedQueue<String>()
  private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  override fun definition() = ModuleDefinition {
    Name("AndroidSpeech")
    Events("live-speech")

    AsyncFunction("startLive") Coroutine { sessionId: String, mode: String, locale: String ->
      if (sessionId.isBlank() || sessionId.length > 200) {
        throw speechError("INVALID_SESSION", "A valid recording session ID is required.")
      }
      if (cancelledSessionIds.contains(sessionId)) {
        throw speechError("CANCELLED", "This recording session was already cancelled.")
      }
      val lifetime = SupervisorJob()
      if (!activeOperation.compareAndSet(null, lifetime)) {
        lifetime.cancel()
        throw speechError("BUSY", "Another on-device speech operation is still running.")
      }
      var session: AndroidLiveSpeechSession? = null
      var recognizer: SpeechRecognizer? = null
      try {
        val client = createRecognizer(mode, locale)
        recognizer = client
        val created = AndroidLiveSpeechSession(sessionId, context(), client, lifetime) { event ->
          sendEvent("live-speech", event)
        }
        session = created
        liveSession.set(created)
        if (cancelledSessionIds.contains(sessionId)) {
          throw speechError("CANCELLED", "This recording session was already cancelled.")
        }
        created.start()
      } catch (error: Throwable) {
        withContext(NonCancellable) {
          if (session != null) session.cancel() else {
            lifetime.cancelAndJoin()
            runCatching { recognizer?.close() }
          }
          liveSession.compareAndSet(session, null)
          activeOperation.compareAndSet(lifetime, null)
        }
        throw error
      }
    }

    AsyncFunction("stopLive") Coroutine { sessionId: String ->
      val session = liveSession.get()?.takeIf { it.id == sessionId }
        ?: throw speechError("STALE_SESSION", "This recording session is no longer active.")
      try {
        session.stop()
      } finally {
        liveSession.compareAndSet(session, null)
        activeOperation.compareAndSet(session.lifetime, null)
      }
    }

    AsyncFunction("cancelLive") Coroutine { sessionId: String ->
      rememberCancelledSession(sessionId)
      val session = liveSession.get()?.takeIf { it.id == sessionId }
      if (session != null) {
        try {
          session.cancel()
        } finally {
          liveSession.compareAndSet(session, null)
          activeOperation.compareAndSet(session.lifetime, null)
        }
      }
    }

    AsyncFunction("convertToWav") Coroutine { audioUri: String ->
      exclusiveOperation {
        withTimeout(TRANSCRIPTION_TIMEOUT_MS) {
          AudioToWavConverter.convert(context(), localAudioUri(audioUri))
        }
      }
    }

    AsyncFunction("getStatus") Coroutine { mode: String, locale: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        return@Coroutine unavailable("ML Kit speech requires Android 12 or later.")
      }
      withContext(Dispatchers.IO) {
        try {
          withRecognizer(mode, locale) { recognizer ->
            withTimeout(STATUS_TIMEOUT_MS) {
              when (recognizer.checkStatus()) {
                FeatureStatus.AVAILABLE -> mapOf("status" to "available")
                FeatureStatus.DOWNLOADABLE -> mapOf("status" to "downloadable")
                FeatureStatus.DOWNLOADING -> mapOf("status" to "downloading")
                else -> unavailable("This mode or language is not supported on this device.")
              }
            }
          }
        } catch (error: TimeoutCancellationException) {
          unavailable("The speech service did not respond. Try again after updating Google services.")
        } catch (error: CancellationException) {
          throw error
        } catch (error: Exception) {
          unavailable(error.message ?: "The on-device speech service is not ready.")
        }
      }
    }

    AsyncFunction("download") Coroutine { mode: String, locale: String ->
      exclusiveOperation {
        withRecognizer(mode, locale) { recognizer ->
          withTimeout(DOWNLOAD_TIMEOUT_MS) {
            when (recognizer.checkStatus()) {
              FeatureStatus.AVAILABLE -> Unit
              FeatureStatus.DOWNLOADABLE -> {
                var completed = false
                recognizer.download().takeWhile { status ->
                  if (status is DownloadStatus.DownloadCompleted) completed = true
                  !completed
                }.collect { status ->
                  if (status is DownloadStatus.DownloadFailed) throw status.e
                }
                if (!completed || recognizer.checkStatus() != FeatureStatus.AVAILABLE) {
                  throw speechError("MODEL_NOT_READY", "The speech model is not ready. Please try again.")
                }
              }
              FeatureStatus.DOWNLOADING -> throw speechError(
                "MODEL_DOWNLOADING", "Google is already downloading this model. Check again shortly."
              )
              else -> throw speechError(
                "UNAVAILABLE", "This speech mode or language is not supported on this device."
              )
            }
          }
        }
      }
    }

    AsyncFunction("transcribe") Coroutine { audioUri: String, mode: String, locale: String ->
      exclusiveOperation {
        withRecognizer(mode, locale) { recognizer ->
          withTimeout(TRANSCRIPTION_TIMEOUT_MS) {
            // A transcription never initiates model downloads and never switches mode/cloud.
            if (recognizer.checkStatus() != FeatureStatus.AVAILABLE) {
              throw speechError("MODEL_NOT_READY", "Download the selected speech model before transcribing.")
            }
            val uri = localAudioUri(audioUri)
            if (mode == "basic") {
              return@withTimeout BasicFileSpeechRecognizer.transcribe(context(), uri, recognizer)
            }
            AudioSource.fromUri(context(), uri).use { source ->
              val request = SpeechRecognizerRequest.Builder().apply {
                audioSource = source
              }.build()
              val text = mutableListOf<String>()
              var completed = false
              recognizer.startRecognition(request).takeWhile { response ->
                if (response is SpeechRecognizerResponse.CompletedResponse) completed = true
                !completed
              }.collect { response ->
                when (response) {
                  is SpeechRecognizerResponse.FinalTextResponse -> text.add(response.text)
                  is SpeechRecognizerResponse.ErrorResponse -> throw response.e
                  else -> Unit // Partial hypotheses must never be saved as a successful result.
                }
              }
              if (!completed) {
                throw speechError("INCOMPLETE", "Speech recognition ended before the recording was complete.")
              }
              mapOf("text" to text.joinToString(" ").trim())
            }
          }
        }
      }
    }

    AsyncFunction("cancel") Coroutine { ->
      val session = liveSession.get()
      if (session != null) {
        rememberCancelledSession(session.id)
        try {
          session.cancel()
        } finally {
          liveSession.compareAndSet(session, null)
          activeOperation.compareAndSet(session.lifetime, null)
        }
      } else activeOperation.get()?.cancelAndJoin()
    }

    AsyncFunction("isBatteryOptimizationExempt") {
      val context = context()
      val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }

    AsyncFunction("openBatteryOptimizationSettings") {
      val context = context()
      // The general settings screen lets the user choose exemption without declaring the
      // restricted REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission in the application.
      try {
        context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
      } catch (_: ActivityNotFoundException) {
        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = Uri.fromParts("package", context.packageName, null)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
      }
    }

    OnDestroy {
      activeOperation.get()?.cancel()
      val session = liveSession.getAndSet(null)
      if (session != null) {
        cleanupScope.launch {
          try { session.cancel() } finally { cleanupScope.cancel() }
        }
      } else cleanupScope.cancel()
    }
  }

  private fun context(): Context = appContext.reactContext
    ?: throw speechError("CONTEXT_UNAVAILABLE", "The Android application is not ready.")

  private fun localAudioUri(value: String): Uri {
    val uri = Uri.parse(value)
    if (uri.scheme == null && value.startsWith('/')) return Uri.fromFile(File(value))
    if (uri.scheme != "file" && uri.scheme != "content") {
      throw speechError("INVALID_AUDIO", "On-device recognition requires a local audio file.")
    }
    return uri
  }

  private suspend fun <T> exclusiveOperation(block: suspend () -> T): T = withContext(Dispatchers.IO) {
    val job = currentCoroutineContext().job
    if (!activeOperation.compareAndSet(null, job)) {
      throw speechError("BUSY", "Another on-device speech operation is still running.")
    }
    try {
      block()
    } catch (error: TimeoutCancellationException) {
      throw speechError("TIMEOUT", "On-device speech timed out. Retry with a shorter recording.", error)
    } catch (error: CancellationException) {
      throw speechError("CANCELLED", "On-device speech was cancelled.", error)
    } finally {
      activeOperation.compareAndSet(job, null)
    }
  }

  private suspend fun <T> withRecognizer(
    mode: String,
    languageTag: String,
    block: suspend (SpeechRecognizer) -> T
  ): T {
    val recognizer = createRecognizer(mode, languageTag)
    try {
      return block(recognizer)
    } catch (error: GenAiException) {
      if (error.message?.contains("NO_SPEECH_DETECTED", ignoreCase = true) == true) {
        throw speechError("NO_SPEECH", "No speech detected. Please try speaking closer to the microphone.", error)
      }
      throw error
    } finally {
      withContext(NonCancellable) {
        try {
          withTimeout(2_000L) { recognizer.stopRecognition() }
        } catch (_: Exception) {
          // close() below still releases the client when the service does not answer stop.
        } finally {
          recognizer.close()
        }
      }
    }
  }

  private fun createRecognizer(mode: String, languageTag: String): SpeechRecognizer {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      throw speechError("UNAVAILABLE", "ML Kit speech requires Android 12 or later.")
    }
    val preferredMode = when (mode) {
      "basic" -> SpeechRecognizerOptions.Mode.MODE_BASIC
      "advanced" -> SpeechRecognizerOptions.Mode.MODE_ADVANCED
      else -> throw speechError("INVALID_MODE", "Unknown Android speech mode.")
    }
    val locale = try {
      Locale.Builder().setLanguageTag(languageTag).build()
    } catch (error: IllformedLocaleException) {
      throw speechError("INVALID_LANGUAGE", "Choose a valid speech language.", error)
    }
    if (locale.language.isEmpty() || locale.language == "auto" || locale.language == "und") {
      throw speechError("INVALID_LANGUAGE", "Choose one speech language when using ML Kit.")
    }
    val options = SpeechRecognizerOptions.Builder().apply {
      this.locale = locale
      this.preferredMode = preferredMode
    }.build()
    return SpeechRecognition.getClient(options)
  }

  private fun rememberCancelledSession(id: String) {
    if (cancelledSessionIds.add(id)) cancelledSessionOrder.add(id)
    while (cancelledSessionOrder.size > 128) {
      cancelledSessionOrder.poll()?.let { cancelledSessionIds.remove(it) }
    }
  }

  private fun unavailable(reason: String) = mapOf("status" to "unavailable", "reason" to reason)

  private fun speechError(code: String, message: String, cause: Throwable? = null) =
    CodedException("ERR_ANDROID_SPEECH_$code", message, cause)

  companion object {
    private const val STATUS_TIMEOUT_MS = 15_000L
    private const val DOWNLOAD_TIMEOUT_MS = 10 * 60_000L
    private const val TRANSCRIPTION_TIMEOUT_MS = 30 * 60_000L
  }
}
