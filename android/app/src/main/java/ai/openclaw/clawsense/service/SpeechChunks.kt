package ai.openclaw.clawsense.service

/** Keep every character while respecting the system TTS limit in UTF-16 units. */
internal fun speechChunks(text: String, maxLength: Int): List<String> {
  require(maxLength >= 2) { "TTS chunk limit must fit a Unicode code point" }
  val normalized = text.trim()
  if (normalized.isEmpty()) return emptyList()
  val chunks = mutableListOf<String>()
  var start = 0
  while (start < normalized.length) {
    var end = minOf(start + maxLength, normalized.length)
    if (end < normalized.length) {
      if (normalized[end - 1].isHighSurrogate() && normalized[end].isLowSurrogate()) end--
      val boundary = (end - 1 downTo start + maxLength / 2)
        .firstOrNull { normalized[it] in "。！？；.!?;\n" }
      if (boundary != null) end = boundary + 1
    }
    chunks += normalized.substring(start, end)
    start = end
  }
  return chunks
}
