package ai.openclaw.clawsense.live

internal fun liveFailureMessage(code: String?): String = when {
  code == "public_harness_not_available" -> "公开场景当前支持本地回答；宿主工作请在本人模式发起。"
  code == "local_harness_fallback_requires_choice" -> "本地模型暂时无法完成。需要时，请明确说“用更强模型”来使用已配置的宿主。"
  code == "external_processing_not_authorized" -> "当前资料未授权交给这个宿主，请检查来源与接收方设置。"
  code == "phone_local_processing_required" -> "当前授权只允许完全本地处理。这个 Live 版本需要手机与电脑协同，未接收声音或画面。"
  code == "live_project_not_authorized" -> "当前设备没有这个项目的 Live 授权，请检查项目范围。"
  code == "harness_artifact_unverified" -> "宿主没有交回可核实的文件，任务尚未完成。请查看宿主结果后再处理。"
  code == "harness_busy" -> "宿主还在处理上一项工作，你可以先继续聊天，稍后再试。"
  code == "configure_harness_model" || code == "configure_stronger_harness_model" -> "这件事需要更强的模型，请在当前宿主的模型设置中配置后再试。"
  code == "local_models_unavailable" || code?.startsWith("model_") == true || code?.startsWith("worker_") == true -> "电脑上的语音组件尚未就绪，请检查 Live 环境后重新连接。"
  code?.contains("unconfirmed") == true -> "宿主连接或响应未完成，任务状态尚未确认。请先查看工作状态，再决定是否重试。"
  code == "invalid_persona" -> "人格配置不完整，请检查设置后再保存。"
  code == "current_frame_unreadable" -> "本次画面暂时无法可靠识别，请换个角度或靠近后再试。"
  code?.startsWith("current_frame_") == true -> "没有取得本次清晰的新画面，请检查镜头后重新提问。"
  code == "local_vision_not_configured" -> "电脑尚未配置本地视觉模型，本次没有使用旧图代替当前画面。"
  code == "execution_reconciliation_required" -> "这项工作曾经执行过，需先核对实际结果，不能自动重新执行。"
  code == "audio_backpressure" -> "电脑处理跟不上实时声音，Live 已停止。请稍后重开，或关闭镜头后再试。"
  code == "audio_ack_timeout" -> "音频播放或传输没有继续，文字已经保留，请重新连接。"
  else -> "这轮对话没有完成，文字已经保留。请检查电脑端运行状态后再试。"
}
internal fun liveNoticeMessage(code: String?): String = when (code) {
  "native_unavailable_using_local" -> "当前原生语音不可用，已使用本地基础方案。"
  "speech_failed_text_preserved" -> "声音暂时不可用，回答文字仍然保留。"
  "address_companion_for_harness_task" -> "请先叫一下搭子的名字，再让它调用宿主执行任务。"
  "persona_saved" -> "人格设置已保存。"
  "speech_stopped_task_unchanged" -> "已停止说话，宿主任务的执行状态保持不变。"
  "unclear_interruption_paused" -> "已暂停，没有听清刚才的打断；可以继续说。"
  "task_cancel_unavailable" -> "声音已停止；当前宿主不能确认取消任务，请在工作状态中查看，必要时在电脑上处理。"
  "task_cancelled" -> "任务执行已停止；此前已经产生的结果仍需检查。"
  "task_cancel_unconfirmed" -> "声音已停止，任务的取消结果尚未确认，请查看工作状态。"
  "no_active_task" -> "当前没有正在排队或执行的工作。"
  "history_unavailable" -> "之前的对话暂时无法恢复，可以继续本次交流。"
  "local_unavailable_using_authorized_harness" -> "本地模型暂时无法完成，按你的设置改用已授权宿主处理。"
  else -> "部分能力暂时不可用，请查看电脑端运行状态。"
}
internal fun liveRouteLabel(route: String): String = when (route) {
  "harness" -> "宿主模型"
  "minicpm-o" -> "原生语音"
  else -> "本地基础模型"
}
internal fun liveWorkStatusLabel(status: String): String = when (status) {
  "queued" -> "已排队"
  "waiting_user" -> "等待本人操作"
  "cancelling" -> "正在确认取消"
  "cancelled" -> "执行端已停止"
  "interrupted" -> "执行中断，待核对"
  "running" -> "进行中"
  "completed" -> "已保存"
  "execution_unconfirmed" -> "执行状态待确认"
  else -> "未完成"
}
