package ai.openclaw.clawsense.live

/** Pure ordering gate shared by the socket client and JVM tests. */
internal class LiveEventGate {
  var sessionId: String = ""; private set
  var turnId: String = ""; private set
  private var seq = 0L
  private var blockedTurn = ""
  @Synchronized fun ready(session: String) { sessionId = session; turnId = ""; seq = 0; blockedTurn = "" }
  @Synchronized fun interrupt() { blockedTurn = turnId }
  @Synchronized fun accept(session: String, turn: String, sequence: Long, type: String): Boolean {
    if (session != sessionId || sequence <= seq) return false
    seq = sequence
    if (type == "turn_started") { turnId = turn; blockedTurn = ""; return true }
    if (type == "interrupted") { blockedTurn = turn; return true }
    // A new question interrupts the previous turn before source/frame preparation.
    // Preparation can fail before turn_started; surface that error while the old
    // turn is blocked. Once a newer turn starts, stale errors remain rejected.
    if (type in listOf("error", "configuration_required") && turn.isNotEmpty() && turnId.isNotEmpty() && turn != turnId && blockedTurn != turnId) return false
    if (type in listOf("audio", "text_delta", "completed")) return turn == turnId && turn != blockedTurn
    return true
  }
}
