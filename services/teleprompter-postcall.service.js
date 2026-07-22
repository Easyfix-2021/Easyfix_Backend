/*
 * Teleprompter POST-CALL orchestration (runs on the bounded ai-post-call-queue, so
 * a burst of ending calls can't saturate Sophy/DB and hurt live calls). For a
 * completed session it:
 *   1. computes the coverage score (asked vs planned) + maps the transcript to the
 *      captured deep-skill options + serviceable pincodes (display/pre-fill only);
 *   2. runs the coaching analysis (Sophy) on the richer real-time transcript and
 *      writes it to the UNIFIED per-call record (tbl_plivo_call_log, matched by
 *      call_uuid) so the Call Analysis page + scorecard treat teleprompter calls
 *      like any other call;
 *   3. refreshes the per-caller scorecard.
 * Best-effort throughout — never throws.
 */

const { pool } = require('../db');
const logger = require('../logger');
const teleprompter = require('./teleprompter.service');
const { resolveFlow } = require('./teleprompter-flows');
const analysisMode = require('./call-analysis-mode.service');
const callerScorecard = require('./caller-scorecard.service');

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

async function processCompleted(sessionId) {
  const s = await teleprompter.getSession(sessionId);
  if (!s) return;
  const flow = resolveFlow(s.flow);
  const questionList = parseJson(s.question_list_json) || [];
  const askedSequence = parseJson(s.asked_sequence_json) || [];
  const transcript = s.transcript || '';

  // 1. coverage + captured skills/areas
  let coverage = null;
  try { coverage = flow.coverage(askedSequence, questionList); } catch { coverage = null; }
  let result = null;
  try { result = await flow.mapResult(transcript, pool); } catch (e) { logger.warn('teleprompter mapResult failed · ' + sessionId + ' · ' + e.message); }
  await teleprompter.saveResult(sessionId, { result, coverage });

  // 2. coaching analysis → unified per-call record (matched by call_uuid)
  //
  // Pinned to TRANSCRIPT mode on purpose — it does NOT follow call.analysis.mode.
  // This path owns a richer real-time STT transcript than any downstream source
  // (that's the whole reason it analyses here), it is keyed by call_uuid with no
  // job_caller_info_id to resolve audio from, and it runs the moment the call
  // ends — before Plivo has filed the recording. Recording mode would be strictly
  // worse here. It still goes through the shared dispatcher rather than calling
  // the LLM directly, so the branch and the `analysis_mode` provenance stamp stay
  // in one place.
  try {
    if (transcript && s.call_uuid) {
      const { analysis } = await analysisMode.analyzeCall({ transcript, mode: analysisMode.MODE_TRANSCRIPT });
      if (analysis) {
        const [r] = await pool.query(
          `UPDATE tbl_plivo_call_log
              SET call_analysis = ?, call_analysis_status = 'ready', call_analysis_generated_at = NOW()
            WHERE call_uuid = ?`,
          [JSON.stringify(analysis), s.call_uuid]);
        if (!r || !r.affectedRows) {
          logger.warn('teleprompter analysis: no tbl_plivo_call_log row for call_uuid ' + s.call_uuid + ' (score won\'t show on the call list)');
        }
      }
    }
  } catch (e) { logger.warn('teleprompter analysis failed · ' + sessionId + ' · ' + e.message); }

  // 3. per-caller scorecard
  try { await callerScorecard.rollupForCaller(s.caller_user_id); } catch { /* best-effort */ }
}

module.exports = { processCompleted };
