  // ── 5. Send push — Appilix-first for deep-links, FCM for the rest ──
  // Appilix native push honors open_link_url (deep-links into the app).
  // FCM in the Appilix WebView does NOT support deep-links (no service
  // worker / Notification API). So when the payload has a URL, prefer
  // Appilix for mobile users, with FCM as fallback for desktop browsers.
  let pushed = 0;
  let appilixSent = false;
  if (shouldSendPush) {
    if (payload.data?.url) {
      // Notification with deep-link URL → Appilix first
      appilixSent = await sendAppilixPush(userId, payload);
      if (!appilixSent) {
        // Appilix unavailable (env keys missing or user not on Appilix)
        pushed = await sendPushToUser(userId, tenantId, payload, supabase);
      }
    } else {
      // Notification without URL → FCM first, Appilix fallback
      pushed = await sendPushToUser(userId, tenantId, payload, supabase);
      if (pushed === 0) {
        appilixSent = await sendAppilixPush(userId, payload);
      }
    }
  }