/**
 * Vitana Email Intake Worker
 *
 * Cloudflare Email Worker that receives emails at tasks@exacy.io
 * and forwards them to the gateway for task creation.
 *
 * Setup:
 * 1. Enable Email Routing on exacy.io in Cloudflare dashboard
 * 2. Create routing rule: tasks@exacy.io → this worker
 * 3. Deploy: cd cloudflare/email-intake-worker && wrangler deploy
 */

export default {
  async email(message, env, ctx) {
    const gatewayUrl = env.GATEWAY_URL || 'https://vitana-gateway-q74ibpv6ia-uc.a.run.app';

    try {
      // Extract email metadata
      const from = message.from;
      const to = message.to;
      const subject = message.headers.get('subject') || '(no subject)';

      // Read the email body
      const rawBody = await new Response(message.raw).text();

      // Extract plain text content from raw email
      // For simple emails, the body is after the headers (double newline)
      const bodyStart = rawBody.indexOf('\r\n\r\n');
      const textBody = bodyStart >= 0
        ? rawBody.substring(bodyStart + 4).trim()
        : rawBody.trim();

      // Truncate body to prevent oversized payloads
      const maxBodyLength = 5000;
      const truncatedBody = textBody.length > maxBodyLength
        ? textBody.substring(0, maxBodyLength) + '\n\n[truncated]'
        : textBody;

      console.log(`[email-intake] Received email from=${from} subject="${subject}"`);

      // Forward to gateway
      const response = await fetch(`${gatewayUrl}/api/v1/intake/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Email-Worker-Secret': env.EMAIL_WORKER_SECRET || '',
        },
        body: JSON.stringify({
          from: from,
          to: to,
          subject: subject,
          text: truncatedBody,
          received_at: new Date().toISOString(),
        }),
      });

      const result = await response.json();

      if (response.ok && result.ok) {
        console.log(`[email-intake] Task created: ${result.vtid} from ${from}`);
      } else {
        console.error(`[email-intake] Gateway rejected: ${response.status} ${result.error || 'unknown'}`);
        // Don't reject the email — it was received, just not processed
      }
    } catch (err) {
      console.error(`[email-intake] Error processing email: ${err.message}`);
      // Don't reject — Cloudflare will retry if we throw
    }
  },
};
