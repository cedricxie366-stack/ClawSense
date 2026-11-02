package ai.openclaw.clawsense.live

/** Transient recognition feedback. This is never a confirmed memory record. */
data class LiveInputReceipt(val id: Long = 0, val status: String? = null, val alternative: String = "") {
  fun update(nextId: Long, nextStatus: String): LiveInputReceipt {
    if (nextId <= 0 || nextId < id || liveInputStatusLabel(nextStatus) == null) return this
    if (nextId == id && nextStatus == "recognizing" && status != null && status != "recognizing") return this
    return LiveInputReceipt(nextId, nextStatus, if (nextId == id) alternative else "")
  }

  fun compare(inputId: Long, selected: String, candidate: String): LiveInputReceipt {
    if (inputId != id || selected.isBlank() || candidate.isBlank() || selected == candidate) return this
    return copy(alternative = candidate.take(400))
  }
}

internal fun liveInputStatusLabel(status: String?): String? = when (status) {
  "recognizing" -> "正在识别这句话…"
  "accepted" -> "已接收这句话；识别内容尚未由本人确认。"
  "address_required" -> "听到了这句话，请先叫搭子的名字再继续。"
  "ambient_ignored" -> "这句没有作为对搭子的请求处理。"
  "backchannel_ignored" -> "听到了简短回应，没有另起回答。"
  "fragment_ignored" -> "这段识别像未说完的片段，没有另起回答。"
  "interruption_unclear" -> "已暂停朗读，但没有听清打断内容；可以继续说。"
  "echo_ignored" -> "这句与刚才的播报相似，已按回声忽略。"
  "too_short" -> "声音片段太短，没有作为完整一句处理。"
  "too_long" -> "这段识别文字过长，请分段说或缩短后重新提问。"
  "no_transcript" -> "这句没有识别出有效文字，可以再说一次或输入文字。"
  "superseded" -> "这句已被后来的操作或输入取代。"
  "control_handled" -> "已处理停止或取消请求；任务结果请看工作状态。"
  "processing_failed" -> "这句没有处理完成，请检查连接或重新提问。"
  else -> null
}
