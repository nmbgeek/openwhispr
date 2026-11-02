package expo.modules.androidspeech

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import com.google.mlkit.genai.common.audio.AudioSource
import com.google.mlkit.genai.speechrecognition.SpeechRecognizer
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerRequest
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import expo.modules.kotlin.exception.CodedException
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch

/**
 * The Basic service on supported devices can reject ONE_SHOT files with NO_SPEECH_DETECTED
 * while recognizing the same bytes over STREAMING. Decode locally, then pace a PCM pipe.
 */
internal object BasicFileSpeechRecognizer {
  suspend fun transcribe(context: Context, uri: Uri, recognizer: SpeechRecognizer): Map<String, String> {
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      throw CodedException(
        "ERR_ANDROID_SPEECH_PERMISSION",
        "ML Kit Basic requires microphone permission, including for file transcription. Allow it in Android settings or use Whisper for file-only transcription.",
        null
      )
    }
    var converted: File? = null
    try {
      val extension = uri.lastPathSegment?.substringAfterLast('.', "")?.lowercase(Locale.ROOT)
      val input = if (extension == "pcm" || extension == "raw") {
        val size = context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
          ?: throw IllegalArgumentException("The audio file could not be opened.")
        require(size > 0 && size % 2L == 0L) { "Raw audio must contain PCM16 mono samples at 16 kHz." }
        PcmInput(
          requireNotNull(context.contentResolver.openInputStream(uri)), OUTPUT_RATE, 1, size / 2
        )
      } else {
        val convertedUri = Uri.parse(AudioToWavConverter.convert(context, uri))
        val file = File(requireNotNull(convertedUri.path))
        converted = file
        PcmInput.fromWave(file)
      }
      input.use { pcm -> return recognizePcm(pcm, recognizer) }
    } finally {
      converted?.delete()
    }
  }

  private suspend fun recognizePcm(input: PcmInput, recognizer: SpeechRecognizer): Map<String, String> {
    val pipe = ParcelFileDescriptor.createPipe()
    try {
      val flags = Os.fcntlInt(pipe[1].fileDescriptor, OsConstants.F_GETFL, 0)
      Os.fcntlInt(pipe[1].fileDescriptor, OsConstants.F_SETFL, flags or OsConstants.O_NONBLOCK)
      AudioSource.fromPfd(pipe[0], AudioSource.Mode.STREAMING).use { source ->
        val request = SpeechRecognizerRequest.Builder().apply { audioSource = source }.build()
        val text = mutableListOf<String>()
        val allAudioWritten = AtomicBoolean(false)
        var completed = false
        coroutineScope {
          val writer = launch(Dispatchers.IO) {
            try {
              // Establish the recognition session before delivering the first audio frame.
              delay(300)
              input.writePaced(pipe[1])
              allAudioWritten.set(true)
            } finally {
              pipe[1].close() // EOF tells the service that the whole recording has arrived.
            }
            delay(500)
            recognizer.stopRecognition()
          }
          try {
            recognizer.startRecognition(request).takeWhile { response ->
              if (response is SpeechRecognizerResponse.CompletedResponse) completed = true
              !completed
            }.collect { response ->
              when (response) {
                is SpeechRecognizerResponse.FinalTextResponse -> text.add(response.text)
                is SpeechRecognizerResponse.ErrorResponse -> throw response.e
                else -> Unit
              }
            }
            if (!completed || !allAudioWritten.get()) {
              throw CodedException(
                "ERR_ANDROID_SPEECH_INCOMPLETE",
                "Speech recognition ended before the whole recording was processed. Try Whisper for this recording.",
                null
              )
            }
            writer.join()
          } finally {
            writer.cancelAndJoin()
          }
        }
        return mapOf("text" to text.joinToString(" ").trim())
      }
    } finally {
      pipe.forEach { runCatching { it.close() } }
    }
  }

  /** Reads bounded buffers and linearly resamples the channel average to PCM16 mono/16 kHz. */
  private class PcmInput(
    stream: InputStream,
    private val sampleRate: Int,
    private val channels: Int,
    private val frames: Long
  ) : AutoCloseable {
    private val input = DataInputStream(BufferedInputStream(stream, 64 * 1024))

    override fun close() = input.close()

    private fun readFrame(): Double {
      var mixed = 0L
      repeat(channels) {
        mixed += java.lang.Short.reverseBytes(input.readShort()).toInt()
      }
      return mixed.toDouble() / channels
    }

    suspend fun writePaced(destination: ParcelFileDescriptor) {
      require(frames > 0) { "The recording does not contain audio." }
      val outputFrames = (frames.toDouble() * OUTPUT_RATE / sampleRate).roundToLong()
      require(outputFrames > 0) { "The recording is too short for speech recognition." }
      var lowerIndex = 0L
      var lower = readFrame()
      var upper = if (frames > 1) readFrame() else lower
      val buffer = ByteBuffer.allocate(FRAMES_PER_CHUNK * 2).order(ByteOrder.LITTLE_ENDIAN)
      val started = SystemClock.elapsedRealtime()
      var writtenFrames = 0L
      while (writtenFrames < outputFrames) {
        currentCoroutineContext().ensureActive()
        buffer.clear()
        val count = minOf(FRAMES_PER_CHUNK.toLong(), outputFrames - writtenFrames).toInt()
        repeat(count) { offset ->
          val position = (writtenFrames + offset).toDouble() * sampleRate / OUTPUT_RATE
          val index = floor(position).toLong()
          while (lowerIndex < index && lowerIndex + 1 < frames) {
            lower = upper
            lowerIndex++
            upper = if (lowerIndex + 1 < frames) readFrame() else lower
          }
          val fraction = (position - lowerIndex).coerceIn(0.0, 1.0)
          val sample = (lower + (upper - lower) * fraction).roundToInt().coerceIn(-32768, 32767)
          buffer.putShort(sample.toShort())
        }
        var offset = 0
        while (offset < buffer.position()) {
          currentCoroutineContext().ensureActive()
          try {
            offset += Os.write(destination.fileDescriptor, buffer.array(), offset, buffer.position() - offset)
          } catch (error: ErrnoException) {
            if (error.errno != OsConstants.EAGAIN) throw error
            delay(5)
          }
        }
        writtenFrames += count
        val wait = writtenFrames * 1_000 / OUTPUT_RATE - (SystemClock.elapsedRealtime() - started)
        if (wait > 0) delay(wait)
      }
    }

    companion object {
      fun fromWave(file: File): PcmInput {
        val stream = file.inputStream()
        try {
          val bytes = ByteArray(44)
          DataInputStream(stream).readFully(bytes)
          val header = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
          require(String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" &&
            String(bytes, 8, 4, Charsets.US_ASCII) == "WAVE" &&
            String(bytes, 36, 4, Charsets.US_ASCII) == "data" &&
            header.getShort(20).toInt() == 1 && header.getShort(34).toInt() == 16) {
            "The decoded recording is not PCM16 WAV."
          }
          val channels = header.getShort(22).toInt()
          val sampleRate = header.getInt(24)
          val size = header.getInt(40).toLong() and 0xffffffffL
          require(channels > 0 && sampleRate > 0 && size % (channels * 2) == 0L) {
            "The decoded recording contains an invalid audio format."
          }
          return PcmInput(stream, sampleRate, channels, size / (channels * 2))
        } catch (error: Throwable) {
          stream.close()
          throw error
        }
      }
    }
  }

  private const val OUTPUT_RATE = 16_000
  private const val FRAMES_PER_CHUNK = 320
}
