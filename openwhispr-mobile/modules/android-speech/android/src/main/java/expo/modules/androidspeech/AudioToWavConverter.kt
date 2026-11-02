package expo.modules.androidspeech

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Decode a complete local recording to PCM16 WAV without holding the recording in memory. */
internal object AudioToWavConverter {
  suspend fun convert(context: Context, source: Uri): String {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    val destination = File.createTempFile("whisper-", ".wav", context.cacheDir)
    var succeeded = false
    try {
      extractor.setDataSource(context, source, null)
      val track = (0 until extractor.trackCount).firstOrNull { index ->
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: throw IllegalArgumentException("The selected file does not contain audio.")
      extractor.selectTrack(track)
      val inputFormat = extractor.getTrackFormat(track)
      val mime = requireNotNull(inputFormat.getString(MediaFormat.KEY_MIME))
      RandomAccessFile(destination, "rw").use { output ->
        output.write(ByteArray(WAV_HEADER_BYTES))
        val pcm = PcmWriter(output)
        if (mime == "audio/raw") {
          pcm.setFormat(inputFormat)
          // WAV/PCM extractors expose packet-sized samples, not the entire recording.
          val requestedCapacity = if (inputFormat.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
            maxOf(inputFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE), 1024 * 1024)
          } else {
            1024 * 1024
          }
          require(requestedCapacity <= MAX_RAW_SAMPLE_BYTES) {
            "The recording contains an oversized audio packet. Convert it to PCM16 WAV first."
          }
          val buffer = ByteBuffer.allocate(requestedCapacity)
          while (true) {
            currentCoroutineContext().ensureActive()
            buffer.clear()
            val count = extractor.readSampleData(buffer, 0)
            if (count < 0) break
            buffer.position(0)
            buffer.limit(count)
            pcm.write(buffer)
            extractor.advance()
          }
        } else {
          inputFormat.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
          val decoder = MediaCodec.createDecoderByType(mime)
          codec = decoder
          decoder.configure(inputFormat, null, null, 0)
          decoder.start()
          var inputEnded = false
          var outputEnded = false
          val info = MediaCodec.BufferInfo()
          while (!outputEnded) {
            currentCoroutineContext().ensureActive()
            if (!inputEnded) {
              val index = decoder.dequeueInputBuffer(CODEC_WAIT_US)
              if (index >= 0) {
                val buffer = requireNotNull(decoder.getInputBuffer(index))
                buffer.clear()
                val count = extractor.readSampleData(buffer, 0)
                if (count < 0) {
                  decoder.queueInputBuffer(index, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                  inputEnded = true
                } else {
                  decoder.queueInputBuffer(index, 0, count, extractor.sampleTime, 0)
                  extractor.advance()
                }
              }
            }
            when (val index = decoder.dequeueOutputBuffer(info, CODEC_WAIT_US)) {
              MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> pcm.setFormat(decoder.outputFormat)
              MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
              else -> if (index >= 0) {
                try {
                  if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                    val buffer = requireNotNull(decoder.getOutputBuffer(index))
                    buffer.position(info.offset)
                    buffer.limit(info.offset + info.size)
                    pcm.write(buffer)
                  }
                  outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                } finally {
                  decoder.releaseOutputBuffer(index, false)
                }
              }
            }
          }
        }
        pcm.finish()
      }
      succeeded = true
      return Uri.fromFile(destination).toString()
    } finally {
      try {
        codec?.release()
      } finally {
        extractor.release()
        if (!succeeded) destination.delete()
      }
    }
  }

  private class PcmWriter(private val output: RandomAccessFile) {
    private var sampleRate = 0
    private var channels = 0
    private var encoding = AudioFormat.ENCODING_PCM_16BIT
    private var bytesWritten = 0L

    fun setFormat(format: MediaFormat) {
      val rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      val count = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      require(rate > 0 && count > 0) { "The recording has an invalid audio format." }
      require(bytesWritten == 0L || rate == sampleRate && count == channels) {
        "The recording changes audio format. Convert it to a single-format WAV first."
      }
      sampleRate = rate
      channels = count
      encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
        format.getInteger(MediaFormat.KEY_PCM_ENCODING)
      } else {
        AudioFormat.ENCODING_PCM_16BIT
      }
      require(encoding == AudioFormat.ENCODING_PCM_16BIT || encoding == AudioFormat.ENCODING_PCM_FLOAT) {
        "The decoded PCM format is not supported. Convert the recording to PCM16 WAV first."
      }
    }

    fun write(buffer: ByteBuffer) {
      check(sampleRate > 0) { "The decoder did not provide an audio format." }
      val bytes = if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
        buffer.order(ByteOrder.LITTLE_ENDIAN)
        require(buffer.remaining() % 4 == 0) { "The recording contains an incomplete PCM sample." }
        ByteBuffer.allocate(buffer.remaining() / 2).order(ByteOrder.LITTLE_ENDIAN).apply {
          while (buffer.hasRemaining()) {
            val sample = buffer.float
            putShort((if (sample.isFinite()) sample.coerceIn(-1f, 1f) * 32767 else 0f).toInt().toShort())
          }
        }.array()
      } else {
        ByteArray(buffer.remaining()).also { buffer.get(it) }
      }
      require(bytesWritten + bytes.size <= 0xffffffffL - 36) {
        "The recording is too large for a WAV file. Split it into shorter recordings."
      }
      output.write(bytes)
      bytesWritten += bytes.size
    }

    fun finish() {
      require(bytesWritten > 0 && sampleRate > 0) { "The recording does not contain decoded audio." }
      require(bytesWritten % (channels * 2) == 0L) { "The recording contains an incomplete PCM frame." }
      val header = ByteBuffer.allocate(WAV_HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN).apply {
        put("RIFF".toByteArray(Charsets.US_ASCII))
        putInt((bytesWritten + 36).toInt())
        put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
        putInt(16)
        putShort(1)
        putShort(channels.toShort())
        putInt(sampleRate)
        putInt(sampleRate * channels * 2)
        putShort((channels * 2).toShort())
        putShort(16)
        put("data".toByteArray(Charsets.US_ASCII))
        putInt(bytesWritten.toInt())
      }
      output.seek(0)
      output.write(header.array())
    }
  }

  private const val WAV_HEADER_BYTES = 44
  private const val MAX_RAW_SAMPLE_BYTES = 4 * 1024 * 1024
  private const val CODEC_WAIT_US = 10_000L
}
