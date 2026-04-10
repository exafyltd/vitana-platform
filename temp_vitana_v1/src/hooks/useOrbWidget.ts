/**
 * ORB Voice Widget Loader Hook
 *
 * Dynamically loads the unified orb-widget.js from the Gateway and initializes
 * VitanaOrb on every screen. This gives community/landing/mobile screens the
 * same full-screen voice overlay that Command Hub uses.
 *
 * Lifecycle:
 * 1. Inject <script src="…/orb-widget.js"> into <head> (once)
 * 2. On load → VitanaOrb.init({ gatewayUrl, authToken, lang, showFab })
 * 3. On session change → VitanaOrb.setAuth(newToken)
 * 4. On unmount → VitanaOrb.destroy() + remove script
 */

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthProvider";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "";
const ORB_SCRIPT_ID = "vitana-orb-widget";

export function useOrbWidget() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const initialized = useRef(false);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // VTID-ANON-SIGNUP: Called by orb-widget when anonymous user signals signup
  // intent. Uses React Router so the navigation is a smooth SPA transition
  // (works inside Appilix WebView with no full page reload).
  const handleSignupRedirect = (url: string) => {
    try {
      navigateRef.current(url);
    } catch (err) {
      console.warn("[ORB] React Router navigate failed, falling back:", err);
      window.location.href = url;
    }
  };

  // ── Load script + init (once) ──────────────────────────────
  useEffect(() => {
    // Prevent double-loading
    if (document.getElementById(ORB_SCRIPT_ID)) {
      // Script already exists — just init if not yet done
      const orb = (window as any).VitanaOrb;
      if (orb && !initialized.current) {
        orb.init({
          gatewayUrl: GATEWAY_URL,
          authToken: session?.access_token || "",
          lang: navigator.language,
          showFab: true,
          onSignupRedirect: handleSignupRedirect,
        });
        initialized.current = true;
      }
      return;
    }

    const script = document.createElement("script");
    script.id = ORB_SCRIPT_ID;
    script.src = `${GATEWAY_URL}/command-hub/orb-widget.js?v=20260410`;
    script.onload = () => {
      const orb = (window as any).VitanaOrb;
      if (orb && !initialized.current) {
        orb.init({
          gatewayUrl: GATEWAY_URL,
          authToken: session?.access_token || "",
          lang: navigator.language,
          showFab: true,
          onSignupRedirect: handleSignupRedirect,
        });
        initialized.current = true;
        console.log("[ORB] Widget loaded and initialized");
      }
    };
    script.onerror = () => {
      console.warn("[ORB] Failed to load orb-widget.js");
    };
    document.head.appendChild(script);

    return () => {
      (window as any).VitanaOrb?.destroy();
      const el = document.getElementById(ORB_SCRIPT_ID);
      if (el) el.remove();
      initialized.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Update auth token when session refreshes ───────────────
  useEffect(() => {
    if (session?.access_token && initialized.current) {
      (window as any).VitanaOrb?.setAuth(session.access_token);
    }
  }, [session?.access_token]);
}
