/*
 * Amazon Transcribe Call Analytics — the OBJECTIVE metrics half of Call
 * Analytics (sentiment, talk-time split, interruptions, non-talk time). Plivo
 * gives us the transcript; Transcribe reads the recording AUDIO from S3 and
 * returns call-quality analytics the LLM can't derive from text.
 *
 * It is an ASYNC batch job (StartCallAnalyticsJob → minutes → result JSON in
 * S3), so it is driven by the call-metrics cron, NOT on-demand. Everything is
 * gated + best-effort: returns null / {ok:false} on any failure, never throws.
 *
 * Config (all required to enable):
 *   - S3_BUCKET_NAME               — recordings live here (same bucket as s3-storage)
 *   - TRANSCRIBE_DATA_ACCESS_ROLE_ARN — IAM role Transcribe assumes to read the
 *                                    recording + write the result back to S3
 *   - AWS_REGION                   — must be a region where Call Analytics exists
 *   - easyfix_properties 'transcribe.analytics.enabled' = 'true'
 * Optional: TRANSCRIBE_OUTPUT_PREFIX (default 'CallAnalytics/'),
 *           TRANSCRIBE_LANGUAGE_CODE (default 'en-IN').
 */

const logger = require('../logger');
const { getProperty } = require('./properties.service');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const BUCKET = process.env.S3_BUCKET_NAME || '';
const ROLE_ARN = process.env.TRANSCRIBE_DATA_ACCESS_ROLE_ARN || '';
const OUTPUT_PREFIX = process.env.TRANSCRIBE_OUTPUT_PREFIX || 'CallAnalytics/';
const LANG = process.env.TRANSCRIBE_LANGUAGE_CODE || 'en-IN';

function propEnabled() {
  return String(getProperty('transcribe.analytics.enabled')).trim().toLowerCase() === 'true';
}
// Turned on AND fully configured.
function enabled() {
  return propEnabled() && !!BUCKET && !!ROLE_ARN;
}

let _client = null;
function client() {
  if (_client) return _client;
  const { TranscribeClient } = require('@aws-sdk/client-transcribe');
  _client = new TranscribeClient({ region: REGION });
  return _client;
}

// Start a post-call analytics job for a recording at s3://BUCKET/<recordingKey>.
async function startJob({ jobName, recordingKey }) {
  if (!enabled()) return { ok: false, error: 'transcribe analytics not enabled/configured' };
  try {
    const { StartCallAnalyticsJobCommand } = require('@aws-sdk/client-transcribe');
    await client().send(new StartCallAnalyticsJobCommand({
      CallAnalyticsJobName: jobName,
      Media: { MediaFileUri: `s3://${BUCKET}/${recordingKey}` },
      OutputLocation: `s3://${BUCKET}/${OUTPUT_PREFIX}`,
      DataAccessRoleArn: ROLE_ARN,
      Settings: { LanguageOptions: [LANG] },
      // Dual-channel recording: channel 0 = agent, 1 = customer. If your Plivo
      // recordings are MONO (single mixed channel), drop ChannelDefinitions —
      // Call Analytics needs 2 channels to attribute agent vs customer, so mono
      // recordings would need a different setup (or fall back to LLM-only).
      ChannelDefinitions: [
        { ChannelId: 0, ParticipantRole: 'AGENT' },
        { ChannelId: 1, ParticipantRole: 'CUSTOMER' },
      ],
    }));
    return { ok: true, jobName };
  } catch (e) {
    logger.warn('transcribe start job failed · ' + jobName + ' · ' + e.message);
    return { ok: false, error: e.message };
  }
}

// Poll a job → { ok, status: IN_PROGRESS|COMPLETED|FAILED, outputUri }.
async function getJob({ jobName }) {
  try {
    const { GetCallAnalyticsJobCommand } = require('@aws-sdk/client-transcribe');
    const r = await client().send(new GetCallAnalyticsJobCommand({ CallAnalyticsJobName: jobName }));
    const j = r?.CallAnalyticsJob || {};
    return {
      ok: true,
      status: j.CallAnalyticsJobStatus || 'UNKNOWN',
      outputUri: j.Transcript?.TranscriptFileUri || null,
      failureReason: j.FailureReason || null,
    };
  } catch (e) {
    logger.warn('transcribe get job failed · ' + jobName + ' · ' + e.message);
    return { ok: false, error: e.message };
  }
}

function extractKey(uri) {
  if (!uri) return null;
  if (uri.startsWith('s3://')) {
    const rest = uri.slice(5);
    const idx = rest.indexOf('/');
    return idx >= 0 ? rest.slice(idx + 1) : null;
  }
  const m = uri.match(/https?:\/\/[^/]+\/(.+)$/);
  if (!m) return null;
  let p = decodeURIComponent(m[1]);
  if (p.startsWith(BUCKET + '/')) p = p.slice(BUCKET.length + 1);
  return p;
}

// Fetch + JSON-parse the Call Analytics result object from its S3 output URI.
async function fetchResultJson(outputUri) {
  try {
    const key = extractKey(outputUri);
    if (!key) return null;
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const c = new S3Client({ region: REGION });
    const r = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await r.Body.transformToString();
    return JSON.parse(text);
  } catch (e) {
    logger.warn('transcribe fetch result failed · ' + e.message);
    return null;
  }
}

// Compact our metrics shape out of the Call Analytics `ConversationCharacteristics`.
// Every field is optional/defensive — the result JSON shape can vary by settings.
function parseMetrics(output) {
  const cc = (output && output.ConversationCharacteristics) || {};
  const sent = (cc.Sentiment && cc.Sentiment.OverallSentiment) || {};
  const details = (cc.TalkTime && cc.TalkTime.DetailsByParticipant) || {};
  const totalTalk = (cc.TalkTime && cc.TalkTime.TotalTimeMillis) || 0;
  const agentMs = (details.AGENT && details.AGENT.TotalTimeMillis) || 0;
  const custMs = (details.CUSTOMER && details.CUSTOMER.TotalTimeMillis) || 0;
  const nonTalkMs = (cc.NonTalkTime && cc.NonTalkTime.TotalTimeMillis);
  return {
    sentiment: {
      agent: sent.AGENT != null ? Number(sent.AGENT) : null,
      customer: sent.CUSTOMER != null ? Number(sent.CUSTOMER) : null,
    },
    talkTime: {
      agentSec: Math.round(agentMs / 1000),
      customerSec: Math.round(custMs / 1000),
      agentRatioPct: totalTalk ? Math.round((agentMs / totalTalk) * 100) : null,
    },
    interruptions: (cc.Interruptions && cc.Interruptions.TotalCount != null) ? Number(cc.Interruptions.TotalCount) : null,
    nonTalkSec: nonTalkMs != null ? Math.round(nonTalkMs / 1000) : null,
  };
}

module.exports = { enabled, propEnabled, startJob, getJob, fetchResultJson, parseMetrics, BUCKET, OUTPUT_PREFIX };
